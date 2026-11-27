import { createHash } from "node:crypto";
import {
  CreateVocabularyCommand,
  GetVocabularyCommand,
  ListVocabulariesCommand,
  TranscribeClient,
  type CreateVocabularyCommandInput,
  type CreateVocabularyCommandOutput,
  type GetVocabularyCommandOutput
} from "@aws-sdk/client-transcribe";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { GlossaryTerm } from "../types.js";
import { resolveAwsRegion } from "./aws-config.js";

export const AWS_VOCABULARY_MAX_BYTES = 50 * 1_024;
export const AWS_VOCABULARY_MAX_ENTRY_CHARACTERS = 256;
export const AWS_VOCABULARY_PREFIX = "lecture-ko-";

export type AwsVocabularyPreparationErrorCode =
  | "INVALID_INPUT"
  | "NOT_CONFIGURED"
  | "QUOTA_GUARD"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_FAILED"
  | "DEPENDENCY_ERROR";

export class AwsVocabularyPreparationError extends Error {
  readonly code: AwsVocabularyPreparationErrorCode;
  readonly httpStatus: 422 | 502 | 503 | 504;
  readonly retryable: boolean;

  constructor(
    code: AwsVocabularyPreparationErrorCode,
    message: string,
    options: { cause?: unknown; retryable?: boolean } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AwsVocabularyPreparationError";
    this.code = code;
    this.httpStatus = code === "INVALID_INPUT"
      ? 422
      : code === "NOT_CONFIGURED" || code === "QUOTA_GUARD"
        ? 503
        : code === "UPSTREAM_TIMEOUT"
          ? 504
          : 502;
    this.retryable = options.retryable ?? (
      code !== "INVALID_INPUT" && code !== "NOT_CONFIGURED" && code !== "QUOTA_GUARD"
    );
  }
}

export class AwsVocabularyPreparationCancelledError extends Error {
  constructor(reason?: unknown) {
    super(
      "AWS 사용자 지정 용어집 준비가 취소되었습니다.",
      reason === undefined ? undefined : { cause: reason }
    );
    this.name = "AwsVocabularyPreparationCancelledError";
  }
}

export type AwsVocabularyPreparationOptions = {
  signal?: AbortSignal;
};

export type AwsVocabularyTranscribePort = {
  getVocabulary: (name: string, signal?: AbortSignal) => Promise<GetVocabularyCommandOutput>;
  createVocabulary: (
    input: CreateVocabularyCommandInput,
    signal?: AbortSignal
  ) => Promise<CreateVocabularyCommandOutput>;
  countVocabularies?: (signal?: AbortSignal) => Promise<number>;
};

export type AwsVocabularyStoragePort = {
  putText: (bucket: string, key: string, body: string, signal?: AbortSignal) => Promise<void>;
  deleteObject: (bucket: string, key: string, signal?: AbortSignal) => Promise<void>;
};

export type AwsVocabularyManagerOptions = {
  region?: string;
  bucket?: string;
  keyPrefix?: string;
  transcribe?: AwsVocabularyTranscribePort;
  storage?: AwsVocabularyStoragePort;
  pollIntervalMs?: number;
  timeoutMs?: number;
  maxVocabularyCount?: number;
  wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
};

export type PreparedAwsVocabulary = {
  vocabularyName: string;
  hash: string;
  reused: boolean;
};

function normalizeCell(value: string): string {
  return value.normalize("NFKC").replace(/[\t\r\n]+/gu, " ").replace(/\s+/gu, " ").trim();
}

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

export function formatAwsVocabularyPhrase(value: string): string {
  const tokens = normalizeCell(value).match(/[가-힣ㄱ-ㅎㅏ-ㅣ]+|[A-Za-z]+(?:'[A-Za-z]+)*|[0-9]|\+|#|&/gu) ?? [];
  return tokens
    .flatMap((token) => {
      if (/^[0-9]$/u.test(token)) return NUMBER_WORDS[Number(token)] || [];
      if (token === "+") return "plus";
      if (token === "#") return "sharp";
      if (token === "&") return "and";
      if (/^[A-Z]{2,10}$/u.test(token)) return `${[...token].join(".")}.`;
      return token;
    })
    .filter(Boolean)
    .join("-");
}

function invalidVocabularyInput(message: string): AwsVocabularyPreparationError {
  return new AwsVocabularyPreparationError("INVALID_INPUT", message, { retryable: false });
}

function validateVocabularyEntry(phrase: string, displayAs: string): void {
  if (phrase.length > AWS_VOCABULARY_MAX_ENTRY_CHARACTERS || displayAs.length > AWS_VOCABULARY_MAX_ENTRY_CHARACTERS) {
    throw invalidVocabularyInput(
      `AWS 사용자 지정 용어집 항목은 ${AWS_VOCABULARY_MAX_ENTRY_CHARACTERS}자 이하여야 합니다.`
    );
  }
}

export function buildAwsVocabularyTable(terms: GlossaryTerm[]): string {
  const entryByPhrase = new Map<string, { phrase: string; displayAs: string }>();
  for (const term of terms) {
    for (const form of [term.term, term.english, ...term.spokenAliases]) {
      const displayAs = normalizeCell(form);
      const phrase = formatAwsVocabularyPhrase(form);
      const key = phrase.toLocaleLowerCase("ko-KR");
      if (!phrase) continue;
      validateVocabularyEntry(phrase, displayAs);
      const existing = entryByPhrase.get(key);
      if (existing?.displayAs === displayAs) continue;
      if (existing) {
        throw invalidVocabularyInput(
          `AWS 용어집 표기 변환 결과가 충돌합니다: "${existing.displayAs}" / "${displayAs}"`
        );
      }
      entryByPhrase.set(key, { phrase, displayAs });
    }
  }
  if (entryByPhrase.size === 0) throw invalidVocabularyInput("AWS 사용자 지정 용어집에 넣을 수 있는 용어가 없습니다.");
  const entries = [...entryByPhrase.values()].sort((left, right) => {
    if (left.phrase < right.phrase) return -1;
    if (left.phrase > right.phrase) return 1;
    if (left.displayAs < right.displayAs) return -1;
    if (left.displayAs > right.displayAs) return 1;
    return 0;
  });
  const rows = [
    "Phrase\tSoundsLike\tIPA\tDisplayAs",
    ...entries.map(({ phrase, displayAs }) => `${phrase}\t\t\t${displayAs}`)
  ];
  const table = `${rows.join("\n")}\n`;
  if (Buffer.byteLength(table, "utf8") > AWS_VOCABULARY_MAX_BYTES) {
    throw invalidVocabularyInput("AWS 사용자 지정 용어집이 50KB 제한을 초과했습니다.");
  }
  return table;
}

export function hashAwsVocabularyTable(table: string): string {
  return createHash("sha256").update(table, "utf8").digest("hex");
}

export function awsVocabularyNameForTerms(terms: GlossaryTerm[]): string {
  return `${AWS_VOCABULARY_PREFIX}${hashAwsVocabularyTable(buildAwsVocabularyTable(terms)).slice(0, 16)}`;
}

export function isManagedAwsVocabularyName(value: string): boolean {
  return /^lecture-ko-[a-f0-9]{16}$/u.test(value);
}

function isMissingVocabulary(error: unknown): boolean {
  const name = typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
  const message = error instanceof Error ? error.message : "";
  return name === "NotFoundException" || (name === "BadRequestException" && /not found|does not exist|couldn't be found/iu.test(message));
}

function isVocabularyConflict(error: unknown): boolean {
  const name = typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
  const message = error instanceof Error ? error.message : "";
  return name === "ConflictException" ||
    (name === "BadRequestException" && /already exists|conflict|in progress/iu.test(message));
}

function dependencyError(error: unknown): AwsVocabularyPreparationError {
  if (error instanceof AwsVocabularyPreparationError) return error;
  return new AwsVocabularyPreparationError(
    "DEPENDENCY_ERROR",
    "AWS 사용자 지정 용어집을 준비하지 못했습니다.",
    { cause: error }
  );
}

function cancellationError(signal?: AbortSignal): AwsVocabularyPreparationCancelledError {
  if (signal?.reason instanceof AwsVocabularyPreparationCancelledError) return signal.reason;
  return new AwsVocabularyPreparationCancelledError(signal?.reason);
}

function throwIfPreparationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancellationError(signal);
}

function waitWithSignal(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfPreparationAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = (): void => {
      clearTimeout(timer);
      reject(cancellationError(signal));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function defaultPorts(region: string): {
  transcribe: AwsVocabularyTranscribePort;
  storage: AwsVocabularyStoragePort;
} {
  const transcribeClient = new TranscribeClient({ region });
  const s3Client = new S3Client({ region });
  return {
    transcribe: {
      getVocabulary: (name, signal) => transcribeClient.send(
        new GetVocabularyCommand({ VocabularyName: name }),
        signal ? { abortSignal: signal } : undefined
      ),
      createVocabulary: (input, signal) => transcribeClient.send(
        new CreateVocabularyCommand(input),
        signal ? { abortSignal: signal } : undefined
      ),
      countVocabularies: async (signal) => {
        let count = 0;
        let nextToken: string | undefined;
        do {
          const page = await transcribeClient.send(new ListVocabulariesCommand({
            MaxResults: 100,
            ...(nextToken ? { NextToken: nextToken } : {})
          }), signal ? { abortSignal: signal } : undefined);
          throwIfPreparationAborted(signal);
          count += page.Vocabularies?.length ?? 0;
          nextToken = page.NextToken;
        } while (nextToken);
        return count;
      }
    },
    storage: {
      putText: async (bucket, key, body, signal) => {
        await s3Client.send(
          new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "text/plain; charset=utf-8" }),
          signal ? { abortSignal: signal } : undefined
        );
      },
      deleteObject: async (bucket, key, signal) => {
        await s3Client.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: key }),
          signal ? { abortSignal: signal } : undefined
        );
      }
    }
  };
}

type PendingVocabularyPreparation = {
  controller: AbortController;
  promise: Promise<PreparedAwsVocabulary>;
  abortableSubscribers: number;
  hasNonAbortableSubscriber: boolean;
  settled: boolean;
};

export class AwsVocabularyManager {
  private readonly bucket: string;
  private readonly keyPrefix: string;
  private readonly transcribe: AwsVocabularyTranscribePort;
  private readonly storage: AwsVocabularyStoragePort;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxVocabularyCount: number;
  private readonly wait: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingVocabularyPreparation>();

  constructor(options: AwsVocabularyManagerOptions = {}) {
    const region = options.region ?? resolveAwsRegion();
    this.bucket = options.bucket?.trim() || process.env.AWS_TRANSCRIBE_VOCABULARY_BUCKET?.trim() || "";
    this.keyPrefix = (options.keyPrefix ?? process.env.AWS_TRANSCRIBE_VOCABULARY_PREFIX ?? "lecture-context/vocabularies")
      .replace(/^\/+|\/+$/gu, "");
    const ports = options.transcribe && options.storage ? null : defaultPorts(region);
    this.transcribe = options.transcribe ?? ports!.transcribe;
    this.storage = options.storage ?? ports!.storage;
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.maxVocabularyCount = Math.max(1, Math.floor(options.maxVocabularyCount ?? 95));
    this.wait = options.wait ?? waitWithSignal;
    this.now = options.now ?? Date.now;
  }

  prepare(
    terms: GlossaryTerm[],
    options: AwsVocabularyPreparationOptions = {}
  ): Promise<PreparedAwsVocabulary> {
    if (options.signal?.aborted) return Promise.reject(cancellationError(options.signal));
    if (!this.bucket) {
      return Promise.reject(
        new AwsVocabularyPreparationError(
          "NOT_CONFIGURED",
          "AWS_TRANSCRIBE_VOCABULARY_BUCKET 설정이 필요합니다."
        )
      );
    }
    const table = buildAwsVocabularyTable(terms);
    const hash = hashAwsVocabularyTable(table);
    const existing = this.pending.get(hash);
    if (existing) return this.subscribe(existing, options.signal);

    const controller = new AbortController();
    let pending!: PendingVocabularyPreparation;
    const operation = this.prepareOnce(table, hash, controller.signal)
      .catch((error) => {
        throwIfPreparationAborted(controller.signal);
        if (error instanceof AwsVocabularyPreparationCancelledError) throw error;
        throw dependencyError(error);
      })
      .finally(() => {
        pending.settled = true;
        if (this.pending.get(hash) === pending) this.pending.delete(hash);
      });
    pending = {
      controller,
      promise: operation,
      abortableSubscribers: 0,
      hasNonAbortableSubscriber: false,
      settled: false
    };
    this.pending.set(hash, pending);
    return this.subscribe(pending, options.signal);
  }

  private subscribe(
    pending: PendingVocabularyPreparation,
    signal?: AbortSignal
  ): Promise<PreparedAwsVocabulary> {
    if (!signal) {
      pending.hasNonAbortableSubscriber = true;
      return pending.promise;
    }
    if (signal.aborted) return Promise.reject(cancellationError(signal));

    pending.abortableSubscribers += 1;
    return new Promise((resolve, reject) => {
      let released = false;
      const release = (callerCancelled: boolean): void => {
        if (released) return;
        released = true;
        signal.removeEventListener("abort", abortCaller);
        pending.abortableSubscribers -= 1;
        if (
          callerCancelled &&
          pending.abortableSubscribers === 0 &&
          !pending.hasNonAbortableSubscriber &&
          !pending.settled &&
          !pending.controller.signal.aborted
        ) {
          pending.controller.abort(cancellationError(signal));
        }
      };
      const abortCaller = (): void => {
        release(true);
        reject(cancellationError(signal));
      };
      signal.addEventListener("abort", abortCaller, { once: true });
      pending.promise.then(
        (result) => {
          release(false);
          resolve(result);
        },
        (error: unknown) => {
          release(false);
          reject(error);
        }
      );
    });
  }

  private async inspect(name: string, signal?: AbortSignal): Promise<GetVocabularyCommandOutput | null> {
    throwIfPreparationAborted(signal);
    try {
      const vocabulary = await this.transcribe.getVocabulary(name, signal);
      throwIfPreparationAborted(signal);
      return vocabulary;
    } catch (error) {
      throwIfPreparationAborted(signal);
      if (isMissingVocabulary(error)) return null;
      throw error;
    }
  }

  private async waitUntilReady(name: string, signal?: AbortSignal): Promise<void> {
    const deadline = this.now() + this.timeoutMs;
    while (true) {
      throwIfPreparationAborted(signal);
      const vocabulary = await this.inspect(name, signal);
      if (!vocabulary) {
        throw new AwsVocabularyPreparationError(
          "UPSTREAM_FAILED",
          "생성 중인 AWS 용어집을 찾지 못했습니다."
        );
      }
      if (vocabulary.VocabularyState === "READY") return;
      if (vocabulary.VocabularyState === "FAILED") {
        throw new AwsVocabularyPreparationError(
          "UPSTREAM_FAILED",
          "AWS 사용자 지정 용어집 생성에 실패했습니다."
        );
      }
      if (this.now() >= deadline) {
        throw new AwsVocabularyPreparationError(
          "UPSTREAM_TIMEOUT",
          "AWS 사용자 지정 용어집 준비 시간이 초과되었습니다."
        );
      }
      await this.wait(this.pollIntervalMs, signal);
      throwIfPreparationAborted(signal);
    }
  }

  private async prepareOnce(
    table: string,
    hash: string,
    signal?: AbortSignal
  ): Promise<PreparedAwsVocabulary> {
    throwIfPreparationAborted(signal);
    const vocabularyName = `${AWS_VOCABULARY_PREFIX}${hash.slice(0, 16)}`;
    const existing = await this.inspect(vocabularyName, signal);
    if (existing?.VocabularyState === "READY") return { vocabularyName, hash, reused: true };
    if (existing?.VocabularyState === "FAILED") {
      throw new AwsVocabularyPreparationError(
        "UPSTREAM_FAILED",
        "같은 내용의 AWS 용어집이 실패 상태입니다. 정리 후 다시 시도해 주세요."
      );
    }
    if (existing) {
      await this.waitUntilReady(vocabularyName, signal);
      return { vocabularyName, hash, reused: true };
    }

    if (this.transcribe.countVocabularies) {
      const vocabularyCount = await this.transcribe.countVocabularies(signal);
      throwIfPreparationAborted(signal);
      if (vocabularyCount >= this.maxVocabularyCount) {
        throw new AwsVocabularyPreparationError(
          "QUOTA_GUARD",
          "AWS 사용자 지정 용어집 수가 안전 한도에 도달했습니다. 오래된 앱 용어집을 검토해 정리해 주세요.",
          { retryable: false }
        );
      }
    }

    const key = `${this.keyPrefix}/${vocabularyName}.txt`;
    let uploaded = false;
    let reusedConcurrentCreation = false;
    try {
      await this.storage.putText(this.bucket, key, table, signal);
      uploaded = true;
      throwIfPreparationAborted(signal);
      try {
        await this.transcribe.createVocabulary({
          VocabularyName: vocabularyName,
          LanguageCode: "ko-KR",
          VocabularyFileUri: `s3://${this.bucket}/${key}`,
          Tags: [
            { Key: "app", Value: "lecture-context-ai" },
            { Key: "content-hash", Value: hash.slice(0, 32) },
            { Key: "created-at", Value: new Date(this.now()).toISOString() }
          ]
        }, signal);
        throwIfPreparationAborted(signal);
      } catch (error) {
        throwIfPreparationAborted(signal);
        if (!isVocabularyConflict(error)) throw error;
        reusedConcurrentCreation = true;
      }
      await this.waitUntilReady(vocabularyName, signal);
    } catch (error) {
      const preparationError = signal?.aborted
        ? cancellationError(signal)
        : error instanceof AwsVocabularyPreparationCancelledError
          ? error
          : dependencyError(error);
      if (
        uploaded &&
        (!(preparationError instanceof AwsVocabularyPreparationError) || preparationError.code !== "UPSTREAM_TIMEOUT")
      ) {
        try {
          await this.storage.deleteObject(this.bucket, key);
        } catch {
          // The original failure is more useful; scheduled cleanup can remove a leftover source object.
        }
      }
      throw preparationError;
    }
    try {
      await this.storage.deleteObject(this.bucket, key);
    } catch {
      // READY vocabulary is usable. Source cleanup is best-effort and can be retried by the cleanup tool.
    }
    return { vocabularyName, hash, reused: reusedConcurrentCreation };
  }
}

import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler, type Request } from "express";
import { z } from "zod";
import {
  analyzeGlossary as defaultAnalyzeGlossary,
  GlossaryAnalysisCancelledError
} from "./services/glossary.js";
import { demoPages, demoTerms } from "./services/demo.js";
import { MAX_PHRASE_SET_FORMS } from "./services/phrase-set-limits.js";
import {
  getGoogleSpeechConfigurationError as defaultGetGoogleSpeechConfigurationError,
  isGoogleSpeechConfigured
} from "./services/google-speech-config.js";
import {
  getAwsTranscribeConfigurationError,
  isAwsTranscribeConfigured,
  resolveSttProvider,
  unverifiedServiceConfiguration
} from "./services/aws-config.js";
import {
  AwsVocabularyManager,
  AwsVocabularyPreparationCancelledError,
  AwsVocabularyPreparationError,
  type AwsVocabularyPreparationOptions,
  type PreparedAwsVocabulary
} from "./services/aws-vocabulary.js";
import { sanitizeGlossaryTerms } from "./services/ws-start.js";
import {
  createFixedWindowRateLimiter,
  positiveEnvironmentInteger,
  resolveClientAddress,
  type FixedWindowRateLimiter
} from "./services/ws-security.js";
import {
  AudioFixtureError,
  AudioFixtureStore,
  FIXTURE_MAX_WAV_BYTES,
  fixtureEnvironmentSchema,
  fixtureSpeakerLabelSchema
} from "./services/audio-fixtures.js";
import {
  readSttComparisonCaseAggregates,
  readSttComparisonResult,
  readSttComparisonResults
} from "./services/stt-comparison-results.js";
import {
  ExperimentStudyError,
  ExperimentStudyStoreService
} from "./services/experiment-studies.js";
import {
  createSttComparisonJobManager,
  type StartSttComparisonJobInput,
  type SttComparisonJob
} from "./services/stt-comparison-jobs.js";
import {
  readSttComparisonLock as defaultReadSttComparisonLock,
  STT_COMPARISON_LOCK_FILE,
  SttComparisonLockError,
  type SttComparisonLockRecord
} from "./services/stt-comparison-lock.js";
import { analyzeRequestSchema, glossaryTermSchema, type GlossaryTerm } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultClientDist = path.resolve(__dirname, "../client");
const defaultFixtureRoot = path.resolve(__dirname, "../../test-fixtures/stt");

const fixtureRequestSchema = z.object({
  scriptId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  speakerLabel: fixtureSpeakerLabelSchema,
  environment: fixtureEnvironmentSchema,
  speakerReadReferenceScriptVerbatim: z.enum(["true", "false"])
    .optional()
    .default("false")
    .transform((value) => value === "true")
}).strict();

const PAID_STT_CALL_CONSENT = "I_UNDERSTAND_3_PAID_GOOGLE_STT_CALLS";
const PUBLIC_STT_COMPARISON_FATAL_ERROR = "STT 비교 작업을 완료하지 못했습니다.";

const startComparisonJobRequestSchema = z.object({
  recordingId: z.string().uuid(),
  paidCallConsent: z.unknown().optional()
}).strict();

const prepareVocabularyRequestSchema = z.object({
  terms: z.array(glossaryTermSchema).min(1).max(50)
}).strict();

export type SttComparisonJobManagerPort = {
  getCurrentJob: () => SttComparisonJob | undefined;
  getJob: (jobId: string) => SttComparisonJob | undefined;
  startJob: (input: StartSttComparisonJobInput) => SttComparisonJob;
};

export type AppOptions = {
  nodeEnv?: string;
  fixtureRoot?: string;
  clientDist?: string;
  jobManager?: SttComparisonJobManagerPort;
  websocketUrl?: string;
  getGoogleSpeechConfigurationError?: () => string | null;
  readSttComparisonLock?: (lockPath: string) => Promise<SttComparisonLockRecord | null>;
  probeProcess?: (pid: number) => void;
  prepareAwsVocabulary?: (
    terms: GlossaryTerm[],
    options?: AwsVocabularyPreparationOptions
  ) => Promise<PreparedAwsVocabulary>;
  analyzeGlossary?: typeof defaultAnalyzeGlossary;
  analyzeRateLimiter?: FixedWindowRateLimiter;
  vocabularyRateLimiter?: FixedWindowRateLimiter;
};

type PublicSttComparisonJob = Pick<SttComparisonJob,
  | "id"
  | "recordingId"
  | "status"
  | "state"
  | "createdAt"
  | "startedAt"
  | "updatedAt"
  | "finishedAt"
  | "completedAt"
  | "progress"
  | "activeRunLabel"
  | "runs"
  | "message"
  | "fatalError"
  | "resultFileName"
>;

type ComparisonLockInspection =
  | { kind: "none" }
  | { kind: "active"; record: SttComparisonLockRecord }
  | { kind: "unsafe" };

export function resolveListenHost(nodeEnv: string | undefined, configuredHost: string | undefined): string {
  if (nodeEnv === "development") return "127.0.0.1";
  return configuredHost?.trim() || "0.0.0.0";
}

function normalizedHostname(value: string): string | null {
  try {
    return new URL(`http://${value}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

function originHostname(value: string): string | null {
  try {
    return new URL(value).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

function isLoopbackHostname(value: string | null): boolean {
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase().split("%")[0];
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

export function isLocalFixtureRequest(input: { remoteAddress?: string; host?: string; origin?: string }): boolean {
  if (!isLoopbackAddress(input.remoteAddress)) return false;
  if (!input.host || !isLoopbackHostname(normalizedHostname(input.host))) return false;
  return !input.origin || isLoopbackHostname(originHostname(input.origin));
}

function requestIsLocal(request: Request): boolean {
  const origin = request.get("origin");
  return isLocalFixtureRequest({
    remoteAddress: request.socket.remoteAddress,
    host: request.get("host"),
    ...(origin ? { origin } : {})
  });
}

function publicSttComparisonJob(job: SttComparisonJob): PublicSttComparisonJob {
  return {
    id: job.id,
    recordingId: job.recordingId,
    status: job.status,
    state: job.state,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    completedAt: job.completedAt,
    progress: job.progress,
    activeRunLabel: job.activeRunLabel,
    runs: job.runs,
    message: job.message,
    fatalError: job.fatalError === null ? null : PUBLIC_STT_COMPARISON_FATAL_ERROR,
    resultFileName: job.resultFileName
  };
}

function externalSttComparisonJob(record: SttComparisonLockRecord) {
  return {
    id: record.jobId,
    owner: record.owner,
    recordingId: record.recordingId,
    startedAt: record.acquiredAt,
    state: "running" as const
  };
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function inspectComparisonLock(
  lockPath: string,
  readLock: (path: string) => Promise<SttComparisonLockRecord | null>,
  probeProcess: (pid: number) => void
): Promise<ComparisonLockInspection> {
  let record: SttComparisonLockRecord | null;
  try {
    record = await readLock(lockPath);
  } catch (error) {
    if (error instanceof SttComparisonLockError) return { kind: "unsafe" };
    throw error;
  }
  if (!record) return { kind: "none" };

  try {
    probeProcess(record.pid);
    return { kind: "active", record };
  } catch (error) {
    if (errnoCode(error) === "EPERM") return { kind: "active", record };
    if (errnoCode(error) === "ESRCH") return { kind: "none" };
    return { kind: "unsafe" };
  }
}

function paginationValue(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function sendApiError(
  response: express.Response,
  status: number,
  code: string,
  error: string
): void {
  response.status(status).json({ error, code });
}

const jsonErrorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  const status = error instanceof AudioFixtureError || error instanceof ExperimentStudyError
    ? error.status
    : error instanceof z.ZodError
      ? 400
    : typeof error === "object" && error !== null && "status" in error && Number.isInteger(error.status)
      ? Number(error.status)
      : 500;
  const message = error instanceof AudioFixtureError || error instanceof ExperimentStudyError
    ? error.message
    : error instanceof z.ZodError
      ? "요청 데이터 형식이나 용어 구성이 올바르지 않습니다. 입력값을 확인해 주세요."
    : status === 413
      ? "요청 본문이 서버의 안전한 크기 제한을 초과했습니다."
      : "요청을 처리하지 못했습니다.";
  if (request.path === "/api/dev/stt-comparison-jobs" && status >= 400 && status < 500) {
    sendApiError(response, status, "INVALID_REQUEST", "STT 비교 작업 요청 형식이 올바르지 않습니다.");
    return;
  }
  response.status(status).json({ error: message });
};

export function createApp(options: AppOptions = {}) {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const app = express();
  const vocabularyManager = options.prepareAwsVocabulary ? null : new AwsVocabularyManager();
  const prepareAwsVocabulary =
    options.prepareAwsVocabulary ?? (
      (terms: GlossaryTerm[], prepareOptions?: AwsVocabularyPreparationOptions) =>
        vocabularyManager!.prepare(terms, prepareOptions)
    );
  const analyzeGlossary = options.analyzeGlossary ?? defaultAnalyzeGlossary;
  const analyzeRateLimiter = options.analyzeRateLimiter ?? createFixedWindowRateLimiter({
    limit: positiveEnvironmentInteger(process.env.MAX_ANALYZE_REQUESTS_PER_MINUTE, 12),
    windowMs: 60_000
  });
  const vocabularyRateLimiter = options.vocabularyRateLimiter ?? createFixedWindowRateLimiter({
    limit: positiveEnvironmentInteger(process.env.MAX_VOCABULARY_REQUESTS_PER_MINUTE, 12),
    windowMs: 60_000
  });
  const trustProxy = process.env.TRUST_PROXY === "1";

  const enforceRateLimit = (
    limiter: FixedWindowRateLimiter,
    request: Request,
    response: express.Response
  ): boolean => {
    const result = limiter.take(resolveClientAddress({
      remoteAddress: request.socket.remoteAddress,
      forwardedFor: request.get("x-forwarded-for"),
      trustProxy
    }));
    if (result.allowed) return true;
    response.set("Retry-After", String(result.retryAfterSeconds));
    response.status(429).json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." });
    return false;
  };

  app.disable("x-powered-by");
  const jsonParser = express.json({ limit: "2mb" });
  app.use((request, response, next) => {
    if (
      request.path === "/api/dev/audio-fixtures" ||
      (nodeEnv !== "development" && request.path.startsWith("/api/dev/"))
    ) {
      next();
      return;
    }
    jsonParser(request, response, next);
  });

  app.get("/api/health", (_request, response) => {
    const sttProvider = resolveSttProvider(process.env.STT_PROVIDER, nodeEnv);
    response.json({
      ok: true,
      sttProvider,
      services: {
        // Health is intentionally local and free: it reports static configuration,
        // never credential/IAM/network success. Operators verify those separately.
        speech: unverifiedServiceConfiguration(
          sttProvider === "aws" ? isAwsTranscribeConfigured() : isGoogleSpeechConfigured()
        ),
        customVocabulary: unverifiedServiceConfiguration(
          sttProvider === "aws" && Boolean(process.env.AWS_TRANSCRIBE_VOCABULARY_BUCKET?.trim())
        ),
        gemini: Boolean(process.env.GEMINI_API_KEY)
      }
    });
  });

  app.post("/api/vocabulary/prepare", async (request, response) => {
    if (!enforceRateLimit(vocabularyRateLimiter, request, response)) return;
    const parsed = prepareVocabularyRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "AWS 사용자 지정 용어집 요청 형식이 올바르지 않습니다." });
      return;
    }
    const terms = sanitizeGlossaryTerms(parsed.data.terms);
    if (terms.length === 0) {
      response.status(422).json({ error: "AWS 사용자 지정 용어집에 사용할 수 있는 용어가 없습니다." });
      return;
    }
    const configurationError = getAwsTranscribeConfigurationError();
    if (configurationError) {
      response.status(503).json({ error: configurationError });
      return;
    }
    const preparationAbort = new AbortController();
    const abortPreparation = (): void => {
      if (!preparationAbort.signal.aborted) {
        preparationAbort.abort(new AwsVocabularyPreparationCancelledError());
      }
    };
    const abortOnResponseClose = (): void => {
      if (!response.writableEnded) abortPreparation();
    };
    request.once("aborted", abortPreparation);
    response.once("close", abortOnResponseClose);
    try {
      const prepared = await prepareAwsVocabulary(terms, { signal: preparationAbort.signal });
      if (preparationAbort.signal.aborted || response.destroyed || response.writableEnded) return;
      response.json(prepared);
    } catch (error) {
      if (
        error instanceof AwsVocabularyPreparationCancelledError ||
        preparationAbort.signal.aborted ||
        response.destroyed ||
        response.writableEnded
      ) {
        return;
      }
      if (error instanceof AwsVocabularyPreparationError) {
        response.status(error.httpStatus).json({
          error: error.message,
          code: error.code,
          retryable: error.retryable
        });
        return;
      }
      response.status(502).json({
        error: "AWS 사용자 지정 용어집을 준비하지 못했습니다. 서버 권한과 리전을 확인해 주세요."
      });
    } finally {
      request.off("aborted", abortPreparation);
      response.off("close", abortOnResponseClose);
    }
  });

  app.get("/api/demo", (_request, response) => {
    response.json({
      title: "생성형 AI 입문 강연",
      pages: demoPages,
      terms: demoTerms,
      phraseSet: demoTerms.flatMap((term) => [term.term, ...term.spokenAliases]).slice(0, MAX_PHRASE_SET_FORMS),
      mode: "demo"
    });
  });

  app.post("/api/analyze", async (request, response) => {
    if (!enforceRateLimit(analyzeRateLimiter, request, response)) return;
    const parsed = analyzeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "PDF 분석 요청 형식이 올바르지 않습니다.", issues: parsed.error.issues });
      return;
    }
    if (parsed.data.pages.reduce((sum, page) => sum + page.text.length, 0) > 600_000) {
      response.status(413).json({ error: "PDF 텍스트가 너무 큽니다. 60만 자 이하 자료를 사용해 주세요." });
      return;
    }
    const analysisAbort = new AbortController();
    const abortAnalysis = (): void => {
      if (!analysisAbort.signal.aborted) analysisAbort.abort(new GlossaryAnalysisCancelledError());
    };
    const abortOnResponseClose = (): void => {
      if (!response.writableEnded) abortAnalysis();
    };
    request.once("aborted", abortAnalysis);
    response.once("close", abortOnResponseClose);
    try {
      const result = await analyzeGlossary(parsed.data.title, parsed.data.pages, {
        signal: analysisAbort.signal
      });
      if (analysisAbort.signal.aborted || response.destroyed || response.writableEnded) return;
      response.json(result);
    } catch (error) {
      if (
        error instanceof GlossaryAnalysisCancelledError ||
        analysisAbort.signal.aborted ||
        response.destroyed ||
        response.writableEnded
      ) {
        return;
      }
      response.status(500).json({ error: error instanceof Error ? error.message : "PDF 분석에 실패했습니다." });
    } finally {
      request.off("aborted", abortAnalysis);
      response.off("close", abortOnResponseClose);
    }
  });

  if (nodeEnv === "development") {
    const fixtureRoot = options.fixtureRoot ?? defaultFixtureRoot;
    const store = new AudioFixtureStore(fixtureRoot);
    const studyStore = new ExperimentStudyStoreService(fixtureRoot);
    const websocketUrl = options.websocketUrl ?? `ws://127.0.0.1:${process.env.PORT || 8787}/ws`;
    const jobManager = options.jobManager ?? createSttComparisonJobManager({ fixtureRoot, websocketUrl });
    const getSpeechConfigurationError = options.getGoogleSpeechConfigurationError
      ?? defaultGetGoogleSpeechConfigurationError;
    const readComparisonLock = options.readSttComparisonLock ?? defaultReadSttComparisonLock;
    const probeProcess = options.probeProcess ?? ((pid: number) => process.kill(pid, 0));
    const comparisonLockPath = path.join(fixtureRoot, STT_COMPARISON_LOCK_FILE);
    const localOnly = (request: Request, response: express.Response, next: express.NextFunction): void => {
      if (!requestIsLocal(request)) {
        response.status(403).json({ error: "개발용 fixture API는 이 컴퓨터의 localhost에서만 사용할 수 있습니다." });
        return;
      }
      next();
    };

    app.get("/api/dev/audio-fixtures", localOnly, async (_request, response, next) => {
      try {
        response.json(await store.getCatalog());
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/dev/experiment-studies", localOnly, async (_request, response, next) => {
      try {
        response.json(await studyStore.getCatalog());
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/dev/experiment-studies", localOnly, async (request, response, next) => {
      try {
        response.status(201).json({ study: await studyStore.createStudy(request.body) });
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/dev/experiment-studies/:studyId/cases", localOnly, async (request, response, next) => {
      try {
        response.status(201).json({
          experimentCase: await studyStore.createCase(String(request.params.studyId), request.body)
        });
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/dev/stt-comparison-aggregates", localOnly, async (request, response, next) => {
      try {
        response.json(await readSttComparisonCaseAggregates(fixtureRoot, {
          ...(typeof request.query.studyId === "string" ? { studyId: request.query.studyId } : {}),
          ...(typeof request.query.caseId === "string" ? { caseId: request.query.caseId } : {})
        }));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/dev/stt-comparisons", localOnly, async (request, response, next) => {
      try {
        response.json(await readSttComparisonResults(fixtureRoot, {
          offset: paginationValue(request.query.offset),
          limit: paginationValue(request.query.limit),
          ...(typeof request.query.studyId === "string" ? { studyId: request.query.studyId } : {}),
          ...(typeof request.query.caseId === "string" ? { caseId: request.query.caseId } : {})
        }));
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/dev/stt-comparisons/:fileName", localOnly, async (request, response, next) => {
      try {
        const detail = await readSttComparisonResult(fixtureRoot, String(request.params.fileName));
        if (!detail) {
          sendApiError(response, 404, "RESULT_NOT_FOUND", "STT 비교 결과를 찾을 수 없습니다.");
          return;
        }
        response.json(detail);
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/dev/stt-comparison-jobs/current", localOnly, async (_request, response, next) => {
      const localJob = jobManager.getCurrentJob();
      if (localJob) {
        response.json({ active: { kind: "local", job: publicSttComparisonJob(localJob) } });
        return;
      }

      try {
        const lock = await inspectComparisonLock(comparisonLockPath, readComparisonLock, probeProcess);
        if (lock.kind === "unsafe") {
          sendApiError(response, 409, "COMPARISON_LOCK_UNSAFE", "STT 비교 lock 상태를 안전하게 확인하지 못했습니다.");
          return;
        }
        response.json({
          active: lock.kind === "active"
            ? { kind: "external", job: externalSttComparisonJob(lock.record) }
            : null
        });
      } catch (error) {
        next(error);
      }
    });

    app.get("/api/dev/stt-comparison-jobs/:jobId", localOnly, (request, response) => {
      const job = jobManager.getJob(String(request.params.jobId));
      if (!job) {
        sendApiError(response, 404, "JOB_NOT_FOUND", "STT 비교 작업을 찾을 수 없습니다.");
        return;
      }
      response.json({ job: publicSttComparisonJob(job) });
    });

    app.post("/api/dev/stt-comparison-jobs", localOnly, async (request, response, next) => {
      const parsed = startComparisonJobRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        sendApiError(response, 400, "INVALID_REQUEST", "STT 비교 작업 요청 형식이 올바르지 않습니다.");
        return;
      }
      if (parsed.data.paidCallConsent !== PAID_STT_CALL_CONSENT) {
        sendApiError(response, 400, "CONSENT_REQUIRED", "유료 Google STT 스트림 3회 호출에 대한 명시적 동의가 필요합니다.");
        return;
      }
      if (jobManager.getCurrentJob()) {
        sendApiError(response, 409, "COMPARISON_BUSY", "다른 STT 비교 작업이 실행 중입니다.");
        return;
      }

      try {
        const lock = await inspectComparisonLock(comparisonLockPath, readComparisonLock, probeProcess);
        if (lock.kind === "active") {
          sendApiError(response, 409, "COMPARISON_BUSY", "다른 STT 비교 작업이 실행 중입니다.");
          return;
        }
        if (lock.kind === "unsafe") {
          sendApiError(response, 409, "COMPARISON_LOCK_UNSAFE", "STT 비교 lock 상태를 안전하게 확인하지 못했습니다.");
          return;
        }

        const configurationError = getSpeechConfigurationError();
        if (configurationError) {
          sendApiError(response, 503, "STT_NOT_CONFIGURED", configurationError);
          return;
        }

        try {
          await store.loadPcm(parsed.data.recordingId);
        } catch (error) {
          if (error instanceof AudioFixtureError && error.status === 404) {
            sendApiError(response, 404, "RECORDING_NOT_FOUND", error.message);
            return;
          }
          throw error;
        }

        if (jobManager.getCurrentJob()) {
          sendApiError(response, 409, "COMPARISON_BUSY", "다른 STT 비교 작업이 실행 중입니다.");
          return;
        }
        const job = jobManager.startJob({ recordingId: parsed.data.recordingId });
        response.status(202).json({ job: publicSttComparisonJob(job) });
      } catch (error) {
        next(error);
      }
    });

    app.post(
      "/api/dev/audio-fixtures",
      localOnly,
      (request, response, next) => {
        const mediaType = request.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        if (mediaType !== "audio/wav" && mediaType !== "audio/x-wav") {
          response.status(415).json({ error: "Content-Type이 audio/wav인 요청만 저장할 수 있습니다." });
          return;
        }
        next();
      },
      express.raw({ type: ["audio/wav", "audio/x-wav"], limit: FIXTURE_MAX_WAV_BYTES, inflate: false }),
      async (request, response, next) => {
        const parsed = fixtureRequestSchema.safeParse({
          scriptId: request.query.scriptId,
          speakerLabel: request.query.speakerLabel,
          environment: request.query.environment,
          speakerReadReferenceScriptVerbatim: request.query.speakerReadReferenceScriptVerbatim
        });
        if (!parsed.success || !Buffer.isBuffer(request.body)) {
          response.status(400).json({ error: "녹음 fixture 메타데이터 또는 WAV 본문 형식이 올바르지 않습니다." });
          return;
        }
        try {
          const recording = await store.save({ ...parsed.data, wav: request.body });
          response.status(201).json({ recording, storageDirectory: "test-fixtures/stt/audio" });
        } catch (error) {
          next(error);
        }
      }
    );
  }

  app.use("/api", (_request, response) => {
    response.status(404).json({ error: "API 경로를 찾을 수 없습니다." });
  });

  app.use(jsonErrorHandler);

  if (nodeEnv === "production") {
    const clientDist = options.clientDist ?? defaultClientDist;
    app.use(express.static(clientDist, { index: false, maxAge: "1h" }));
    app.get("*splat", (_request, response) => response.sendFile(path.join(clientDist, "index.html")));
  }

  return app;
}

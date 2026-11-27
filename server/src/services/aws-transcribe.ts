import {
  StartStreamTranscriptionCommand,
  TranscribeStreamingClient,
  type Item,
  type Result,
  type StartStreamTranscriptionCommandInput,
  type StartStreamTranscriptionCommandOutput,
  type TranscriptResultStream
} from "@aws-sdk/client-transcribe-streaming";
import { AwsAudioQueue } from "./aws-audio-queue.js";
import {
  resolveAwsTranscribeConfiguration,
  type AwsPartialResultsStability,
  type AwsTranscribeConfiguration
} from "./aws-config.js";
import type { SttSession } from "./stt-session.js";

type TimeoutHandle = ReturnType<typeof setTimeout>;

export type AwsTranscriptEmission = {
  text: string;
  isFinal: boolean;
  providerResultId?: string;
  stablePrefixLength?: number;
  startTimeMs?: number;
  endTimeMs?: number;
};

export type AwsTranscribeCallbacks = {
  onProviderAccepted: (metadata: { requestId?: string; sessionId?: string }) => void;
  onTranscript: (emission: AwsTranscriptEmission) => void;
  onError: (error: Error) => void;
  onEnd: (result: { flushTimedOut: boolean }) => void;
  onDrain?: () => void;
};

export type AwsTranscribeStreamingPort = {
  send: (
    command: StartStreamTranscriptionCommand,
    options?: { abortSignal?: AbortSignal }
  ) => Promise<StartStreamTranscriptionCommandOutput>;
};

export type AwsTranscribeDependencies = {
  client?: AwsTranscribeStreamingPort;
  configuration?: AwsTranscribeConfiguration;
  setTimer?: (callback: () => void, delayMs: number) => TimeoutHandle;
  clearTimer?: (handle: TimeoutHandle) => void;
};

const sharedClients = new Map<string, TranscribeStreamingClient>();

function getSharedClient(region: string): TranscribeStreamingClient {
  const existing = sharedClients.get(region);
  if (existing) return existing;
  const client = new TranscribeStreamingClient({ region });
  sharedClients.set(region, client);
  return client;
}

export function buildAwsStreamingRequest(
  audioStream: StartStreamTranscriptionCommandInput["AudioStream"],
  stability: AwsPartialResultsStability,
  vocabularyName?: string
): StartStreamTranscriptionCommandInput {
  const normalizedVocabularyName = vocabularyName?.trim();
  return {
    LanguageCode: "ko-KR",
    MediaEncoding: "pcm",
    MediaSampleRateHertz: 16_000,
    AudioStream: audioStream,
    ...(stability === "off"
      ? {}
      : {
          EnablePartialResultsStabilization: true,
          PartialResultsStability: stability
        }),
    ...(normalizedVocabularyName ? { VocabularyName: normalizedVocabularyName } : {})
  };
}

function milliseconds(seconds: number | undefined): number | undefined {
  return seconds === undefined ? undefined : Math.max(0, Math.round(seconds * 1_000));
}

export function findAwsStablePrefixLength(transcript: string, items: Item[] | undefined): number {
  if (!items?.length) return 0;
  let searchFrom = 0;
  let stableEnd = 0;
  for (const item of items) {
    if (item.Stable !== true || !item.Content) break;
    const start = transcript.indexOf(item.Content, searchFrom);
    if (start < 0) break;
    stableEnd = start + item.Content.length;
    searchFrom = stableEnd;
  }
  return stableEnd;
}

export function projectAwsResult(result: Result): AwsTranscriptEmission | null {
  const alternative = result.Alternatives?.[0];
  const text = alternative?.Transcript?.trim();
  if (!text) return null;
  const isFinal = result.IsPartial === false;
  const startTimeMs = milliseconds(result.StartTime);
  const endTimeMs = milliseconds(result.EndTime);
  return {
    text,
    isFinal,
    ...(result.ResultId ? { providerResultId: result.ResultId } : {}),
    ...(!isFinal ? { stablePrefixLength: findAwsStablePrefixLength(text, alternative?.Items) } : {}),
    ...(startTimeMs === undefined ? {} : { startTimeMs }),
    ...(endTimeMs === undefined ? {} : { endTimeMs })
  };
}

function streamMemberError(member: TranscriptResultStream): Error | null {
  const values = Object.entries(member as unknown as Record<string, unknown>);
  for (const [key, value] of values) {
    if (!key.endsWith("Exception")) continue;
    const message =
      typeof value === "object" && value !== null && "Message" in value
        ? String((value as { Message?: unknown }).Message || key)
        : key;
    return new Error(message);
  }
  return null;
}

export function createAwsTranscribeSession(
  vocabularyName: string | undefined,
  callbacks: AwsTranscribeCallbacks,
  dependencies: AwsTranscribeDependencies = {}
): SttSession {
  const configuration = dependencies.configuration ?? resolveAwsTranscribeConfiguration();
  const client = dependencies.client ?? getSharedClient(configuration.region);
  const setTimer = dependencies.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = dependencies.clearTimer ?? ((handle) => clearTimeout(handle));
  const controller = new AbortController();
  let lifecycle: "active" | "draining" | "ended" | "failed" | "aborted" = "active";
  let providerAccepted = false;
  let providerTimer: TimeoutHandle | null = null;
  let drainTimer: TimeoutHandle | null = null;
  let queue: AwsAudioQueue;

  const isTerminal = (): boolean =>
    lifecycle === "ended" || lifecycle === "failed" || lifecycle === "aborted";
  const clearTimers = (): void => {
    if (providerTimer) clearTimer(providerTimer);
    if (drainTimer) clearTimer(drainTimer);
    providerTimer = null;
    drainTimer = null;
  };
  const unrefTimer = (timer: TimeoutHandle): void => {
    if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") timer.unref();
  };
  const fail = (error: Error): void => {
    if (isTerminal()) return;
    lifecycle = "failed";
    clearTimers();
    queue.abort();
    controller.abort(error);
    callbacks.onError(error);
  };
  const end = (flushTimedOut: boolean): void => {
    if (isTerminal()) return;
    lifecycle = "ended";
    clearTimers();
    queue.abort();
    if (flushTimedOut) controller.abort(new Error("AWS Transcribe final 자막 대기 시간이 초과되었습니다."));
    callbacks.onEnd({ flushTimedOut });
  };
  const armProviderTimeout = (): void => {
    if (providerAccepted || isTerminal() || providerTimer) return;
    providerTimer = setTimer(
      () => fail(new Error("AWS Transcribe 연결 준비 시간이 초과되었습니다.")),
      Math.max(0, configuration.providerTimeoutMs)
    );
    unrefTimer(providerTimer);
  };

  queue = new AwsAudioQueue({
    onFirstAudio: armProviderTimeout,
    onLowWatermark: callbacks.onDrain,
    onOverflow: fail
  });

  const run = async (): Promise<void> => {
    try {
      const output = await client.send(
        new StartStreamTranscriptionCommand(
          buildAwsStreamingRequest(queue, configuration.partialResultsStability, vocabularyName)
        ),
        { abortSignal: controller.signal }
      );
      if (isTerminal()) return;
      providerAccepted = true;
      if (providerTimer) clearTimer(providerTimer);
      providerTimer = null;
      callbacks.onProviderAccepted({
        ...(output.$metadata.requestId ? { requestId: output.$metadata.requestId } : {}),
        ...(output.SessionId ? { sessionId: output.SessionId } : {})
      });

      if (!output.TranscriptResultStream) throw new Error("AWS Transcribe 응답 스트림이 없습니다.");
      for await (const member of output.TranscriptResultStream) {
        if (isTerminal()) return;
        const memberError = streamMemberError(member);
        if (memberError) throw memberError;
        for (const result of member.TranscriptEvent?.Transcript?.Results || []) {
          const emission = projectAwsResult(result);
          if (emission) callbacks.onTranscript(emission);
        }
      }
      if (lifecycle === "draining") {
        end(false);
      } else {
        fail(new Error("AWS Transcribe 응답 스트림이 입력 종료 전에 예상치 못하게 종료되었습니다."));
      }
    } catch (error) {
      if (isTerminal()) return;
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  };
  void run();

  return {
    enqueueAudio: (audio) => queue.enqueue(audio),
    finishInput() {
      if (lifecycle !== "active") return;
      lifecycle = "draining";
      queue.finish();
      drainTimer = setTimer(() => end(true), Math.max(0, configuration.drainTimeoutMs));
      unrefTimer(drainTimer);
    },
    abort(reason) {
      if (isTerminal()) return;
      lifecycle = "aborted";
      clearTimers();
      queue.abort();
      controller.abort(reason ?? new Error("AWS Transcribe 세션이 중단되었습니다."));
    }
  };
}

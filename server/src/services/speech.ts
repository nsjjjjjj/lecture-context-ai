import { protos, v2 } from "@google-cloud/speech";
import {
  resolveGoogleSpeechConfiguration,
  type SpeechDiagnosticEvent,
  type SpeechDiagnosticStage
} from "./google-speech-config.js";
import { MAX_PHRASE_SET_FORMS } from "./phrase-set-limits.js";
import type { AudioEnqueueResult, SttSession } from "./stt-session.js";

export {
  createDevelopmentSpeechDiagnosticReporter,
  getGoogleSpeechConfigurationError,
  isGoogleSpeechConfigured,
  type DevelopmentSpeechDiagnosticRecord,
  type SpeechDiagnosticEvent,
  type SpeechDiagnosticStage
} from "./google-speech-config.js";

type StreamingRecognizeRequest = protos.google.cloud.speech.v2.IStreamingRecognizeRequest;
type StreamingRecognizeResponse = protos.google.cloud.speech.v2.IStreamingRecognizeResponse;

export type TranscriptEmission = {
  text: string;
  isFinal: boolean;
};

type SpeechCallbacks = {
  onTranscript: (text: string, isFinal: boolean) => void;
  onError: (error: Error) => void;
  onEnd: () => void;
  onDrain?: () => void;
  onDiagnostic?: (event: SpeechDiagnosticEvent) => void;
};

type SpeechWritablePort = {
  destroyed?: boolean;
  writable?: boolean;
  writableEnded?: boolean;
  write: (value: StreamingRecognizeRequest, callback?: (error?: Error | null) => void) => unknown;
};

type SpeechWritableStream = SpeechWritablePort & {
  end: () => void;
  cancel?: () => void;
  on(event: "data", callback: (response: StreamingRecognizeResponse) => void): unknown;
  on(event: "error", callback: (error: Error) => void): unknown;
  on(event: "end" | "close" | "drain", callback: () => void): unknown;
};

export type SpeechClientPort = Pick<v2.SpeechClient, "initialize" | "_streamingRecognize">;

type SpeechSessionDependencies = {
  client?: SpeechClientPort;
  drainTimeoutMs?: number;
  readyTimeoutMs?: number;
};

const SHORT_ENDPOINTING_SENSITIVITY =
  protos.google.cloud.speech.v2.StreamingRecognitionFeatures.EndpointingSensitivity
    .ENDPOINTING_SENSITIVITY_SHORT;
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_READY_TIMEOUT_MS = 5_000;

const clientInitializations = new WeakMap<object, Promise<void>>();
let sharedSpeechClient: SpeechClientPort | null = null;

export function initializeSpeechClient(client: SpeechClientPort): Promise<void> {
  const identity = client as object;
  const existing = clientInitializations.get(identity);
  if (existing) return existing;

  const initialization = Promise.resolve(client.initialize()).then(() => undefined);
  clientInitializations.set(identity, initialization);
  return initialization;
}

function getSharedSpeechClient(apiEndpoint: string): SpeechClientPort {
  if (!sharedSpeechClient) sharedSpeechClient = new v2.SpeechClient({ apiEndpoint });
  return sharedSpeechClient;
}

export function isSpeechStreamWritable(stream: SpeechWritablePort): boolean {
  return stream.destroyed !== true && stream.writableEnded !== true && stream.writable !== false;
}

export function createGuardedSpeechWriter(stream: SpeechWritablePort, onError: (error: Error) => void) {
  let stopped = false;

  const fail = (error: unknown): void => {
    if (stopped) return;
    stopped = true;
    onError(error instanceof Error ? error : new Error(String(error)));
  };

  return {
    write(value: StreamingRecognizeRequest, onComplete?: (error?: Error) => void): boolean {
      if (stopped || !isSpeechStreamWritable(stream)) return false;
      try {
        const accepted = stream.write(value, (error?: Error | null) => {
          if (error) fail(error);
          onComplete?.(error ?? undefined);
        });
        return accepted !== false;
      } catch (error) {
        fail(error);
        onComplete?.(error instanceof Error ? error : new Error(String(error)));
        return false;
      }
    },
    fail,
    stop(): void {
      stopped = true;
    }
  };
}

export function projectStreamingRecognizeResponse(
  response: StreamingRecognizeResponse
): TranscriptEmission[] {
  const finalEmissions: TranscriptEmission[] = [];
  const interimParts: string[] = [];

  for (const result of response.results ?? []) {
    const transcript = result.alternatives?.[0]?.transcript;
    if (typeof transcript !== "string") continue;

    if (result.isFinal) {
      const text = transcript.trim();
      if (text) finalEmissions.push({ text, isFinal: true });
      continue;
    }

    interimParts.push(transcript);
  }

  const interimText = interimParts.join("").trim();
  if (!interimText) return finalEmissions;

  return [...finalEmissions, { text: interimText, isFinal: false }];
}

export function buildStreamingRecognizeRequest(
  projectId: string,
  location: string,
  model: string,
  phraseSet: string[]
): StreamingRecognizeRequest {
  const config: protos.google.cloud.speech.v2.IRecognitionConfig = {
    explicitDecodingConfig: {
      encoding: "LINEAR16",
      sampleRateHertz: 16_000,
      audioChannelCount: 1
    },
    languageCodes: ["ko-KR"],
    model,
    features: { enableAutomaticPunctuation: true }
  };

  if (phraseSet.length > 0) {
    config.adaptation = {
      phraseSets: [
        {
          inlinePhraseSet: {
            phrases: phraseSet.slice(0, MAX_PHRASE_SET_FORMS).map((value) => ({ value }))
          }
        }
      ]
    };
  }

  return {
    recognizer: `projects/${projectId}/locations/${location}/recognizers/_`,
    streamingConfig: {
      config,
      streamingFeatures: {
        interimResults: true,
        enableVoiceActivityEvents: true,
        endpointingSensitivity: SHORT_ENDPOINTING_SENSITIVITY
      }
    }
  };
}

function resolveSpeechActivityStage(
  eventType: StreamingRecognizeResponse["speechEventType"]
): SpeechDiagnosticStage | null {
  if (eventType === 2 || eventType === "SPEECH_ACTIVITY_BEGIN") return "vad-begin";
  if (eventType === 3 || eventType === "SPEECH_ACTIVITY_END") return "vad-end";
  return null;
}

export async function createGoogleSpeechSession(
  phraseSet: string[],
  callbacks: SpeechCallbacks,
  dependencies: SpeechSessionDependencies = {}
): Promise<SttSession> {
  const { projectId, location, model, apiEndpoint } = resolveGoogleSpeechConfiguration();
  const drainTimeoutMs = dependencies.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const readyTimeoutMs = dependencies.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const client = dependencies.client ?? getSharedSpeechClient(apiEndpoint);
  const startedAt = performance.now();
  let pcmChunkCount = 0;
  let pcmBytes = 0;
  const diagnostic = (stage: SpeechDiagnosticStage): void => {
    callbacks.onDiagnostic?.({
      stage,
      elapsedMs: Math.max(0, performance.now() - startedAt),
      pcmChunkCount,
      pcmBytes
    });
  };

  try {
    await initializeSpeechClient(client);
  } catch (error) {
    if (!dependencies.client && sharedSpeechClient === client) sharedSpeechClient = null;
    throw error;
  }
  diagnostic("client-initialized");

  const stream = client._streamingRecognize() as SpeechWritableStream;
  let lifecycle: "active" | "draining" | "ended" | "failed" | "aborted" = "active";
  let drainTimer: NodeJS.Timeout | null = null;
  let readyTimer: NodeJS.Timeout | null = null;
  let writer: ReturnType<typeof createGuardedSpeechWriter> | null = null;
  let initialWriteReject: ((error: Error) => void) | null = null;
  let firstInterimSeen = false;
  let firstFinalSeen = false;

  const isTerminal = (): boolean =>
    lifecycle === "ended" || lifecycle === "failed" || lifecycle === "aborted";
  const clearDrainTimer = (): void => {
    if (!drainTimer) return;
    clearTimeout(drainTimer);
    drainTimer = null;
  };
  const clearReadyTimer = (): void => {
    if (!readyTimer) return;
    clearTimeout(readyTimer);
    readyTimer = null;
  };
  const finish = (kind: "end" | "error", error?: Error): boolean => {
    if (isTerminal()) return false;

    lifecycle = kind === "error" ? "failed" : "ended";
    clearDrainTimer();
    clearReadyTimer();
    writer?.stop();
    const terminalError = error ?? new Error("Google STT 스트림이 준비되기 전에 종료되었습니다.");
    initialWriteReject?.(terminalError);
    initialWriteReject = null;
    if (kind === "error") callbacks.onError(terminalError);
    else callbacks.onEnd();
    if (kind === "error") {
      try {
        stream.cancel?.();
      } catch {
        // Terminal callbacks are already settled; cancellation is best-effort cleanup.
      }
    }
    return true;
  };
  const abort = (reason?: Error): void => {
    if (isTerminal()) return;

    lifecycle = "aborted";
    clearDrainTimer();
    clearReadyTimer();
    writer?.stop();
    initialWriteReject?.(reason ?? new Error("Google STT 세션이 중단되었습니다."));
    initialWriteReject = null;
    diagnostic("session-abort");
    try {
      stream.cancel?.();
    } catch {
      // The session is already terminal; cancellation is best-effort cleanup.
    }
  };
  writer = createGuardedSpeechWriter(stream, (error) => finish("error", error));

  stream.on("data", (response: StreamingRecognizeResponse) => {
    if (isTerminal()) return;
    const activityStage = resolveSpeechActivityStage(response.speechEventType);
    if (activityStage) diagnostic(activityStage);
    for (const emission of projectStreamingRecognizeResponse(response)) {
      if (emission.isFinal && !firstFinalSeen) {
        firstFinalSeen = true;
        diagnostic("first-final");
      } else if (!emission.isFinal && !firstInterimSeen) {
        firstInterimSeen = true;
        diagnostic("first-interim");
      }
      callbacks.onTranscript(emission.text, emission.isFinal);
    }
  });
  stream.on("error", (error: Error) => {
    finish("error", error);
  });
  stream.on("end", () => {
    finish("end");
  });
  stream.on("close", () => {
    finish("end");
  });
  stream.on("drain", () => {
    if (isTerminal()) return;
    diagnostic("grpc-drain");
    callbacks.onDrain?.();
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearReadyTimer();
      initialWriteReject = null;
      if (error) reject(error);
      else resolve();
    };
    initialWriteReject = (error) => settle(error);
    readyTimer = setTimeout(
      () => writer?.fail(new Error("Google STT 초기 설정 전송 시간이 초과되었습니다.")),
      Math.max(0, readyTimeoutMs)
    );
    readyTimer.unref();
    writer?.write(buildStreamingRecognizeRequest(projectId, location, model, phraseSet), settle);
  });
  if (lifecycle !== "active") throw new Error("Google STT 스트림이 준비되기 전에 종료되었습니다.");
  diagnostic("config-written");

  return {
    enqueueAudio(audio: Buffer): AudioEnqueueResult {
      if (lifecycle !== "active") return "closed";
      if (audio.byteLength > 15_000) {
        writer?.fail(new Error("오디오 청크가 Google STT의 15KB 제한을 초과했습니다."));
        return "closed";
      }
      pcmChunkCount += 1;
      pcmBytes += audio.byteLength;
      if (pcmChunkCount === 1) diagnostic("first-pcm");
      const accepted = writer?.write({ audio }) === true;
      if (accepted) return "accepted";
      if (lifecycle !== "active") return "closed";
      diagnostic("grpc-backpressure");
      return "backpressure";
    },
    finishInput() {
      if (lifecycle !== "active") return;

      lifecycle = "draining";
      diagnostic("session-close");
      drainTimer = setTimeout(() => {
        try {
          stream.cancel?.();
        } finally {
          finish("end");
        }
      }, Math.max(0, drainTimeoutMs));
      drainTimer.unref();

      if (stream.destroyed) {
        finish("end");
        return;
      }
      if (stream.writableEnded) return;

      try {
        stream.end();
      } catch (error) {
        finish("error", error instanceof Error ? error : new Error(String(error)));
      }
    },
    abort
  };
}

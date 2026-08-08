import { protos, v2 } from "@google-cloud/speech";

type StreamingRecognizeRequest = protos.google.cloud.speech.v2.IStreamingRecognizeRequest;
type StreamingRecognizeResponse = protos.google.cloud.speech.v2.IStreamingRecognizeResponse;

type SpeechCallbacks = {
  onTranscript: (text: string, isFinal: boolean) => void;
  onError: (error: Error) => void;
  onEnd: () => void;
};

export type SpeechSession = {
  writeAudio: (audio: Buffer) => void;
  close: () => void;
};

type SpeechWritableStream = {
  destroyed?: boolean;
  writable?: boolean;
  writableEnded?: boolean;
  write: (value: StreamingRecognizeRequest, callback?: (error?: Error | null) => void) => unknown;
};

export type SpeechClientPort = Pick<v2.SpeechClient, "_streamingRecognize" | "close">;

type SpeechSessionDependencies = {
  client?: SpeechClientPort;
  drainTimeoutMs?: number;
};

const SUPPORTED_STT_LOCATION = "us";
const SUPPORTED_STT_MODEL = "chirp_3";
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

type GoogleSpeechConfiguration = {
  projectId: string;
  location: typeof SUPPORTED_STT_LOCATION;
  model: typeof SUPPORTED_STT_MODEL;
  apiEndpoint: string;
};

export function getGoogleSpeechConfigurationError(): string | null {
  if (!process.env.GOOGLE_CLOUD_PROJECT) return "GOOGLE_CLOUD_PROJECT가 설정되지 않았습니다.";

  const location = process.env.GOOGLE_STT_LOCATION || SUPPORTED_STT_LOCATION;
  if (location !== SUPPORTED_STT_LOCATION) {
    return `GOOGLE_STT_LOCATION은 지원되는 값 '${SUPPORTED_STT_LOCATION}'이어야 합니다.`;
  }

  const model = process.env.GOOGLE_STT_MODEL || SUPPORTED_STT_MODEL;
  if (model !== SUPPORTED_STT_MODEL) {
    return `GOOGLE_STT_MODEL은 지원되는 값 '${SUPPORTED_STT_MODEL}'이어야 합니다.`;
  }

  return null;
}

function resolveGoogleSpeechConfiguration(): GoogleSpeechConfiguration {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) throw new Error("GOOGLE_CLOUD_PROJECT가 설정되지 않았습니다.");

  const error = getGoogleSpeechConfigurationError();
  if (error) throw new Error(error);

  return {
    projectId,
    location: SUPPORTED_STT_LOCATION,
    model: SUPPORTED_STT_MODEL,
    apiEndpoint: `${SUPPORTED_STT_LOCATION}-speech.googleapis.com`
  };
}

export function isSpeechStreamWritable(stream: SpeechWritableStream): boolean {
  return stream.destroyed !== true && stream.writableEnded !== true && stream.writable !== false;
}

export function createGuardedSpeechWriter(stream: SpeechWritableStream, onError: (error: Error) => void) {
  let stopped = false;

  const fail = (error: unknown): void => {
    if (stopped) return;
    stopped = true;
    onError(error instanceof Error ? error : new Error(String(error)));
  };

  return {
    write(value: StreamingRecognizeRequest): boolean {
      if (stopped || !isSpeechStreamWritable(stream)) return false;
      try {
        stream.write(value, (error?: Error | null) => {
          if (error) fail(error);
        });
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    },
    fail,
    stop(): void {
      stopped = true;
    }
  };
}

export function isGoogleSpeechConfigured(): boolean {
  return getGoogleSpeechConfigurationError() === null;
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
            phrases: phraseSet.slice(0, 50).map((value) => ({ value }))
          }
        }
      ]
    };
  }

  return {
    recognizer: `projects/${projectId}/locations/${location}/recognizers/_`,
    streamingConfig: {
      config,
      streamingFeatures: { interimResults: true }
    }
  };
}

export function createGoogleSpeechSession(
  phraseSet: string[],
  callbacks: SpeechCallbacks,
  dependencies: SpeechSessionDependencies = {}
): SpeechSession {
  const { projectId, location, model, apiEndpoint } = resolveGoogleSpeechConfiguration();
  const drainTimeoutMs = dependencies.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const client = dependencies.client ?? new v2.SpeechClient({ apiEndpoint });
  const stream = client._streamingRecognize();
  let clientClosed = false;
  let lifecycle: "active" | "draining" | "ended" | "failed" = "active";
  let drainTimer: NodeJS.Timeout | null = null;
  let writer: ReturnType<typeof createGuardedSpeechWriter> | null = null;

  const isTerminal = (): boolean => lifecycle === "ended" || lifecycle === "failed";
  const clearDrainTimer = (): void => {
    if (!drainTimer) return;
    clearTimeout(drainTimer);
    drainTimer = null;
  };
  const closeClient = (): void => {
    if (clientClosed) return;
    clientClosed = true;
    try {
      void client.close().catch(() => undefined);
    } catch {
      // Cleanup failures cannot emit a second terminal callback.
    }
  };
  const finish = (kind: "end" | "error", error?: Error): boolean => {
    if (isTerminal()) return false;

    lifecycle = kind === "error" ? "failed" : "ended";
    clearDrainTimer();
    writer?.stop();
    try {
      if (kind === "error") callbacks.onError(error ?? new Error("Google STT 스트림이 실패했습니다."));
      else callbacks.onEnd();
    } finally {
      closeClient();
    }
    return true;
  };
  writer = createGuardedSpeechWriter(stream, (error) => finish("error", error));

  stream.on("data", (response: StreamingRecognizeResponse) => {
    if (isTerminal()) return;
    for (const result of response.results ?? []) {
      const text = result.alternatives?.[0]?.transcript?.trim();
      if (!text) continue;
      callbacks.onTranscript(text, Boolean(result.isFinal));
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

  writer.write(buildStreamingRecognizeRequest(projectId, location, model, phraseSet));

  return {
    writeAudio(audio: Buffer) {
      if (lifecycle !== "active") return;
      if (audio.byteLength > 15_000) {
        writer?.fail(new Error("오디오 청크가 Google STT의 15KB 제한을 초과했습니다."));
        return;
      }
      writer?.write({ audio });
    },
    close() {
      if (lifecycle !== "active") return;

      lifecycle = "draining";
      drainTimer = setTimeout(() => finish("end"), Math.max(0, drainTimeoutMs));
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
    }
  };
}

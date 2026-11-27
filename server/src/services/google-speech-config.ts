export const SUPPORTED_GOOGLE_STT_LOCATION = "us";
export const SUPPORTED_GOOGLE_STT_MODEL = "chirp_3";

export type GoogleSpeechConfiguration = {
  projectId: string;
  location: typeof SUPPORTED_GOOGLE_STT_LOCATION;
  model: typeof SUPPORTED_GOOGLE_STT_MODEL;
  apiEndpoint: string;
};

export type SpeechDiagnosticStage =
  | "client-initialized"
  | "config-written"
  | "first-pcm"
  | "grpc-backpressure"
  | "grpc-drain"
  | "vad-begin"
  | "vad-end"
  | "first-interim"
  | "first-final"
  | "session-close"
  | "session-abort";

export type SpeechDiagnosticEvent = {
  stage: SpeechDiagnosticStage;
  elapsedMs: number;
  pcmChunkCount: number;
  pcmBytes: number;
};

export type DevelopmentSpeechDiagnosticRecord = SpeechDiagnosticEvent & { sessionId: string };

export function getGoogleSpeechConfigurationError(): string | null {
  if (!process.env.GOOGLE_CLOUD_PROJECT) return "GOOGLE_CLOUD_PROJECT가 설정되지 않았습니다.";

  const location = process.env.GOOGLE_STT_LOCATION || SUPPORTED_GOOGLE_STT_LOCATION;
  if (location !== SUPPORTED_GOOGLE_STT_LOCATION) {
    return `GOOGLE_STT_LOCATION은 지원되는 값 '${SUPPORTED_GOOGLE_STT_LOCATION}'이어야 합니다.`;
  }

  const model = process.env.GOOGLE_STT_MODEL || SUPPORTED_GOOGLE_STT_MODEL;
  if (model !== SUPPORTED_GOOGLE_STT_MODEL) {
    return `GOOGLE_STT_MODEL은 지원되는 값 '${SUPPORTED_GOOGLE_STT_MODEL}'이어야 합니다.`;
  }

  return null;
}

export function resolveGoogleSpeechConfiguration(): GoogleSpeechConfiguration {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) throw new Error("GOOGLE_CLOUD_PROJECT가 설정되지 않았습니다.");

  const error = getGoogleSpeechConfigurationError();
  if (error) throw new Error(error);

  return {
    projectId,
    location: SUPPORTED_GOOGLE_STT_LOCATION,
    model: SUPPORTED_GOOGLE_STT_MODEL,
    apiEndpoint: `${SUPPORTED_GOOGLE_STT_LOCATION}-speech.googleapis.com`
  };
}

export function isGoogleSpeechConfigured(): boolean {
  return getGoogleSpeechConfigurationError() === null;
}

export function createDevelopmentSpeechDiagnosticReporter(
  development: boolean,
  sessionId: string,
  reporter: (record: DevelopmentSpeechDiagnosticRecord) => void
): ((event: SpeechDiagnosticEvent) => void) | undefined {
  if (!development) return undefined;
  return (event) => reporter({ sessionId, ...event });
}

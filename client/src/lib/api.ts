import type { AnalysisResult, GlossaryTerm, PageText, ServiceStatus } from "../types";

export type AudioFixtureTargetTerm = {
  id: string;
  canonicalTerm: string;
  english: string;
  spokenAliases: string[];
  expectedOccurrences: number[];
};

export type AudioFixtureScript = {
  id: string;
  title: string;
  languageCode: "ko-KR";
  text: string;
  targetTerms: AudioFixtureTargetTerm[];
};

export type AudioFixtureRecording = {
  id: string;
  fileName: string;
  relativePath: string;
  scriptId: string;
  speakerLabel: "speaker-a" | "speaker-b";
  environment: "quiet" | "noisy";
  createdAt: string;
  durationMs: number;
  sampleRate: 16000;
  channels: 1;
  bitsPerSample: 16;
  dataBytes: number;
  speakerReadReferenceScriptVerbatim: boolean;
};

export type AudioFixtureCatalog = {
  scripts: AudioFixtureScript[];
  recordings: AudioFixtureRecording[];
  storageDirectory: string;
};

export const comparisonRunLabels = [
  "without-phrase-set",
  "canonical-phrase-set",
  "spoken-alias-phrase-set"
] as const;

export type ComparisonRunLabel = typeof comparisonRunLabels[number];
export type ComparisonEvaluationMode = "accuracy" | "smoke";
export type ComparisonOccurrenceOutcome = "direct-recognition" | "alias-correction" | "miss";
export type ComparisonUnexpectedKind = "false-correction" | "false-insertion";

export type ComparisonRunMetrics = {
  evaluationMode: ComparisonEvaluationMode;
  accuracyValid: boolean;
  directRecognitions: number;
  aliasCorrectionSuccesses: number;
  misses: number;
  falseCorrections: number;
  falseInsertions: number;
  expectedOccurrenceCount: number;
  productLinkRate: number;
};

export type ComparisonOccurrenceResult = {
  sequence: number;
  targetTermId: string;
  canonicalTerm: string;
  outcome: ComparisonOccurrenceOutcome;
  finalTranscriptIndex: number | null;
  rawText: string | null;
};

export type ComparisonUnexpectedObservation = {
  kind: ComparisonUnexpectedKind;
  reason: "invalid-correction" | "unexpected-alias-correction" | "unexpected-direct-match";
  targetTermId: string | null;
  finalTranscriptIndex: number;
  rawText: string;
};

export type ComparisonTranscriptCorrection = {
  originalText: string;
  correctedText: string;
  termId: string;
  displayStart: number;
  displayEnd: number;
  reason: "spokenAlias";
};

export type ComparisonFinalTranscript = {
  text: string;
  rawText: string;
  detectedTermIds: string[];
  corrections: ComparisonTranscriptCorrection[];
};

export type ComparisonRunResult = {
  label: ComparisonRunLabel;
  status: "completed" | "error";
  phraseSet: string[];
  terms: GlossaryTerm[];
  startedAt: string;
  readyAfterMs: number | null;
  audioDurationMs: number;
  wallClockMs: number;
  interimCount: number;
  finalTranscripts: ComparisonFinalTranscript[];
  transcript: string;
  rawTranscript: string;
  metrics: ComparisonRunMetrics;
  occurrenceResults: ComparisonOccurrenceResult[];
  unexpectedObservations: ComparisonUnexpectedObservation[];
  errors: string[];
};

export type ComparisonReportV3 = {
  version: 3;
  createdAt: string;
  recording: {
    id: string;
    scriptId: string;
    speakerReadReferenceScriptVerbatim: boolean;
    evaluationMode: ComparisonEvaluationMode;
  };
  script: AudioFixtureScript;
  websocketUrl: string;
  measurementNote: string;
  runs: ComparisonRunResult[];
};

export type LegacyComparisonReport = {
  version: 1 | 2;
  [key: string]: unknown;
};

export type ComparisonReportFile = ComparisonReportV3 | LegacyComparisonReport;

export type SttComparisonJobState =
  | "starting"
  | "running"
  | "writing-result"
  | "completed"
  | "completed-with-errors"
  | "failed";

export type SttComparisonJobRunState = "pending" | "running" | "completed" | "error";

export type SttComparisonJobRunStatus = {
  label: ComparisonRunLabel;
  state: SttComparisonJobRunState;
  message: string | null;
  error: string | null;
};

export type SttComparisonJobProgress = {
  completed: number;
  total: 3;
  percent: number;
};

export type SttComparisonJobStatus = {
  id: string;
  recordingId: string;
  status: SttComparisonJobState;
  state: SttComparisonJobState;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  completedAt: string | null;
  progress: SttComparisonJobProgress;
  activeRunLabel: ComparisonRunLabel | null;
  runs: SttComparisonJobRunStatus[];
  message: string | null;
  fatalError: string | null;
  resultFileName: string | null;
};

export type ExternalSttComparisonJob = {
  id: string;
  owner: "cli" | "ui";
  recordingId: string;
  startedAt: string;
  state: "running";
};

export type CurrentSttComparisonJob =
  | { kind: "local"; job: SttComparisonJobStatus }
  | { kind: "external"; job: ExternalSttComparisonJob };

export type SttComparisonHistoryItem = {
  fileName: string;
  modifiedAt: string;
  version: ComparisonReportFile["version"];
  createdAt: string | null;
  recordingId: string | null;
  scriptTitle: string | null;
  evaluationMode: ComparisonEvaluationMode | null;
  runOutcome: "complete" | "has-errors" | "legacy";
};

export type SttComparisonPage = {
  offset: number;
  limit: number;
  hasMore: boolean;
};

export type SttComparisonCatalog = {
  latest: ComparisonReportFile | null;
  latestFileName: string | null;
  reportCount: number;
  history: SttComparisonHistoryItem[];
  page: SttComparisonPage;
};

export type SttComparisonDetail = {
  fileName: string;
  modifiedAt: string;
  report: ComparisonReportFile;
};

export const PAID_STT_CALL_CONSENT = "I_UNDERSTAND_3_PAID_GOOGLE_STT_CALLS" as const;

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "요청을 처리하지 못했습니다.");
  return body;
}

export async function getHealth(): Promise<ServiceStatus> {
  const response = await fetch("/api/health");
  return readJson<ServiceStatus>(response);
}

export async function getDemo(): Promise<AnalysisResult> {
  const response = await fetch("/api/demo");
  return readJson<AnalysisResult>(response);
}

export async function analyzePdf(title: string, pages: PageText[]): Promise<AnalysisResult> {
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, pages })
  });
  const result = await readJson<Omit<AnalysisResult, "pages">>(response);
  return { ...result, pages };
}

export async function getAudioFixtures(): Promise<AudioFixtureCatalog> {
  const response = await fetch("/api/dev/audio-fixtures");
  return readJson<AudioFixtureCatalog>(response);
}

export async function saveAudioFixture(input: {
  wav: Blob;
  scriptId: string;
  speakerLabel: "speaker-a" | "speaker-b";
  environment: "quiet" | "noisy";
  speakerReadReferenceScriptVerbatim: boolean;
}): Promise<{ recording: AudioFixtureRecording; storageDirectory: string }> {
  const query = new URLSearchParams({
    scriptId: input.scriptId,
    speakerLabel: input.speakerLabel,
    environment: input.environment,
    speakerReadReferenceScriptVerbatim: String(input.speakerReadReferenceScriptVerbatim)
  });
  const response = await fetch(`/api/dev/audio-fixtures?${query.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: input.wav
  });
  return readJson<{ recording: AudioFixtureRecording; storageDirectory: string }>(response);
}

export async function startSttComparisonJob(recordingId: string): Promise<{ job: SttComparisonJobStatus }> {
  const response = await fetch("/api/dev/stt-comparison-jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recordingId, paidCallConsent: PAID_STT_CALL_CONSENT })
  });
  return readJson<{ job: SttComparisonJobStatus }>(response);
}

export async function getCurrentSttComparisonJob(): Promise<{ active: CurrentSttComparisonJob | null }> {
  const response = await fetch("/api/dev/stt-comparison-jobs/current", { cache: "no-store" });
  return readJson<{ active: CurrentSttComparisonJob | null }>(response);
}

export async function getSttComparisonJob(jobId: string): Promise<{ job: SttComparisonJobStatus }> {
  const response = await fetch(`/api/dev/stt-comparison-jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
  return readJson<{ job: SttComparisonJobStatus }>(response);
}

export async function getSttComparisons({ offset = 0, limit = 5 }: { offset?: number; limit?: number } = {}): Promise<SttComparisonCatalog> {
  const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  const response = await fetch(`/api/dev/stt-comparisons?${query.toString()}`, { cache: "no-store" });
  return readJson<SttComparisonCatalog>(response);
}

export async function getSttComparison(fileName: string): Promise<SttComparisonDetail> {
  const response = await fetch(`/api/dev/stt-comparisons/${encodeURIComponent(fileName)}`, { cache: "no-store" });
  return readJson<SttComparisonDetail>(response);
}

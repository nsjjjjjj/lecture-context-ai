export type PageText = {
  pageNumber: number;
  text: string;
};

export type GlossaryTerm = {
  id: string;
  term: string;
  english: string;
  spokenAliases: string[];
  easyExplanation: string;
  pageNumber: number;
  occurrences: number;
  source: "gemini" | "heuristic" | "demo";
};

export type AnalysisResult = {
  title: string;
  pages: PageText[];
  terms: GlossaryTerm[];
  phraseSet: string[];
  mode: "gemini" | "heuristic" | "demo" | "saved";
  warning?: string;
  vocabularyName?: string;
};

export type TranscriptSegmentMetadata = {
  segmentId: string;
  providerResultId?: string;
  revision: number;
  stablePrefixLength?: number;
  startTimeMs?: number;
  endTimeMs?: number;
};

export type TranscriptSegmentEvent = TranscriptSegmentMetadata & {
  type: "partial" | "final";
  text: string;
  rawText?: string;
  detectedTerms?: string[];
  relatedPage?: number;
  corrections?: TranscriptCorrection[];
};

export type LegacyInterimTranscriptEvent = {
  type: "interim";
  text?: string;
  segmentId?: string;
  revision?: number;
};

export type TranscriptBasicControlEvent = {
  type: "ready" | "captureRequested" | "readyForAudio" | "providerAccepted" | "status" | "error";
  message?: string;
};

export type TranscriptEndedEvent = {
  type: "ended";
  outcome: "completed" | "flush-timeout";
  message?: string;
};

export type TranscriptControlEvent = TranscriptBasicControlEvent | TranscriptEndedEvent;

export type TranscriptEvent = TranscriptSegmentEvent | LegacyInterimTranscriptEvent | TranscriptControlEvent;

export type TranscriptCorrection = {
  originalText: string;
  correctedText: string;
  termId: string;
  displayStart: number;
  displayEnd: number;
  reason: "spokenAlias";
};

export type TranscriptLine = {
  id: string;
  text: string;
  rawText: string;
  termIds: string[];
  relatedPage?: number;
  corrections: TranscriptCorrection[];
};

export type ServiceVerification = "unverified" | "verified" | "failed";

export type ServiceConfigurationStatus = {
  configured: boolean;
  verification: ServiceVerification;
};

export type ServiceStatus = {
  ok: boolean;
  sttProvider?: "aws" | "google";
  services: {
    speech: ServiceConfigurationStatus;
    gemini: boolean;
    customVocabulary?: ServiceConfigurationStatus;
  };
};

export type PreparedAwsVocabulary = {
  vocabularyName: string;
  hash: string;
  reused: boolean;
};

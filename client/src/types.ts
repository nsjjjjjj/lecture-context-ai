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
  pdfUrl?: string;
};

export type TranscriptEvent = {
  type: "ready" | "interim" | "final" | "status" | "error" | "ended";
  text?: string;
  rawText?: string;
  message?: string;
  detectedTerms?: string[];
  relatedPage?: number;
  corrections?: TranscriptCorrection[];
};

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

export type ServiceStatus = {
  ok: boolean;
  services: { speech: boolean; gemini: boolean };
};

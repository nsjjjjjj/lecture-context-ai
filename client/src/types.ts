export type PageText = {
  pageNumber: number;
  text: string;
};

export type GlossaryTerm = {
  id: string;
  term: string;
  english: string;
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
  mode: "gemini" | "heuristic" | "demo";
  warning?: string;
  pdfUrl?: string;
};

export type TranscriptEvent = {
  type: "ready" | "interim" | "final" | "status" | "error" | "ended";
  text?: string;
  message?: string;
  detectedTerms?: string[];
  relatedPage?: number;
  latencyMs?: number;
};

export type TranscriptLine = {
  id: string;
  text: string;
  termIds: string[];
  relatedPage?: number;
  latencyMs: number;
};

export type ServiceStatus = {
  ok: boolean;
  services: { speech: boolean; gemini: boolean };
};

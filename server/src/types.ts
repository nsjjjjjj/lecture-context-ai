import { z } from "zod";

export const pageTextSchema = z.object({
  pageNumber: z.number().int().positive(),
  text: z.string().max(80_000)
});

export const glossaryTermSchema = z.object({
  id: z.string(),
  term: z.string().min(2).max(80),
  english: z.string().max(120).optional().default(""),
  spokenAliases: z.array(z.string()).max(24).optional().default([]),
  easyExplanation: z.string().min(2).max(240),
  pageNumber: z.number().int().positive(),
  occurrences: z.number().int().nonnegative(),
  source: z.enum(["gemini", "heuristic", "demo"])
});

export const analyzeRequestSchema = z.object({
  title: z.string().max(160).optional().default("강연 자료"),
  pages: z.array(pageTextSchema).min(1).max(300)
});

export type PageText = z.infer<typeof pageTextSchema>;
export type GlossaryTerm = z.infer<typeof glossaryTermSchema>;

export type AnalysisResult = {
  title: string;
  terms: GlossaryTerm[];
  phraseSet: string[];
  mode: "gemini" | "heuristic" | "demo";
  warning?: string;
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

export type StartMessage = {
  type: "start";
  mode: "live" | "demo";
  terms: GlossaryTerm[];
  phraseSet: string[];
};

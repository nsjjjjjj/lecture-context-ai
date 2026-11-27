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
}).superRefine(({ pages }, context) => {
  pages.forEach((page, index) => {
    const expectedPageNumber = index + 1;
    if (page.pageNumber === expectedPageNumber) return;
    context.addIssue({
      code: "custom",
      path: ["pages", index, "pageNumber"],
      message: `페이지 번호는 1부터 순서대로 이어져야 합니다. ${expectedPageNumber}페이지가 필요합니다.`
    });
  });
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

export type TranscriptEvent = TranscriptSegmentEvent | TranscriptControlEvent;

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
  vocabularyName?: string;
};

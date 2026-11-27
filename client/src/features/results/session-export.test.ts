import { describe, expect, it } from "vitest";
import type { TranscriptLine } from "../../types";
import {
  createLectureSessionExport,
  safeSessionExportBaseName,
  serializeLectureSessionJson,
  serializeLectureTranscriptText,
  shouldConfirmSessionDiscard
} from "./session-export";

const lines: TranscriptLine[] = [{
  id: "line-1",
  text: "검색 증강 생성입니다.",
  rawText: "검색 증강 생선입니다.",
  termIds: ["rag"],
  relatedPage: 3,
  corrections: [{
    termId: "rag",
    originalText: "생선",
    correctedText: "생성",
    displayStart: 6,
    displayEnd: 8,
    reason: "spokenAlias"
  }]
}];

const glossaryTerms = [{
  id: "rag",
  term: "검색 증강 생성",
  english: "Retrieval-Augmented Generation",
  spokenAliases: ["생선"],
  easyExplanation: "검색 결과를 답변 생성에 함께 쓰는 방식",
  pageNumber: 3,
  occurrences: 2,
  source: "demo" as const
}];

describe("lecture session export", () => {
  it("preserves display text, raw text, corrections, terms, pages, and terminal outcome", () => {
    const result = createLectureSessionExport({
      title: "RAG 강연",
      exportedAt: "2026-08-29T10:00:00+09:00",
      mode: "live",
      outcome: { status: "flush-timeout", reason: "client-flush-timeout", message: "일부 미확정" },
      lines,
      glossaryTerms
    });

    expect(result).toEqual({
      version: 2,
      title: "RAG 강연",
      exportedAt: "2026-08-29T01:00:00.000Z",
      mode: "live",
      outcome: { status: "flush-timeout", reason: "client-flush-timeout", message: "일부 미확정" },
      glossary: {
        totalTermCount: 1,
        snapshotTruncated: false,
        terms: glossaryTerms
      },
      transcript: lines
    });
    expect(JSON.parse(serializeLectureSessionJson({
      title: "RAG 강연",
      exportedAt: "2026-08-29T01:00:00.000Z",
      mode: "live",
      outcome: result.outcome,
      lines,
      glossaryTerms
    })).transcript[0]).toMatchObject({ rawText: "검색 증강 생선입니다.", relatedPage: 3 });
  });

  it("creates a readable text copy without hiding raw corrections", () => {
    const text = serializeLectureTranscriptText({
      title: "RAG 강연",
      exportedAt: "2026-08-29T01:00:00.000Z",
      mode: "live",
      outcome: { status: "completed", reason: "server-ended", message: "완료" },
      lines,
      glossaryTerms
    });

    expect(text).toContain("1. 검색 증강 생성입니다.");
    expect(text).toContain("원문: 검색 증강 생선입니다.");
    expect(text).toContain("용어: 검색 증강 생성 (rag)");
    expect(text).toContain("교정:");
  });

  it("produces a filesystem-safe bounded base name", () => {
    expect(safeSessionExportBaseName("  RAG: 강연/결과?  ")).toBe("RAG- 강연-결과-");
    expect(safeSessionExportBaseName("\u0000")).toBe("lecture-caption-session");
  });

  it("warns only while a non-empty result has not been preserved", () => {
    expect(shouldConfirmSessionDiscard("results", 12, "not-exported")).toBe(true);
    expect(shouldConfirmSessionDiscard("results", 12, "download-requested")).toBe(true);
    expect(shouldConfirmSessionDiscard("results", 12, "confirmed")).toBe(false);
    expect(shouldConfirmSessionDiscard("results", 0, "not-exported")).toBe(false);
    expect(shouldConfirmSessionDiscard("live", 12, "not-exported")).toBe(false);
  });

  it("puts referenced terms first in a bounded self-contained glossary snapshot", () => {
    const manyTerms = Array.from({ length: 55 }, (_, index) => ({
      ...glossaryTerms[0],
      id: `term-${index}`,
      term: `용어 ${index}`
    }));
    const result = createLectureSessionExport({
      title: "긴 용어집",
      exportedAt: "2026-08-29T01:00:00.000Z",
      mode: "demo",
      outcome: null,
      lines: [{ ...lines[0], termIds: ["term-54"], corrections: [] }],
      glossaryTerms: manyTerms
    });

    expect(result.glossary.terms).toHaveLength(50);
    expect(result.glossary.terms[0].id).toBe("term-54");
    expect(result.glossary.snapshotTruncated).toBe(true);
  });

  it("refuses an orphan term id instead of emitting an uninterpretable result", () => {
    expect(() => createLectureSessionExport({
      title: "손상된 결과",
      exportedAt: "2026-08-29T01:00:00.000Z",
      mode: "demo",
      outcome: null,
      lines: [{ ...lines[0], termIds: ["missing"], corrections: [] }],
      glossaryTerms
    })).toThrow("자막 용어 ID를 찾지 못했습니다");
  });
});

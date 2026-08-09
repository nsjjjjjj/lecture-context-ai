import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GlossaryTerm, TranscriptLine } from "../types";
import { buildCaptionDisplayParts, TransparentCaption } from "./TransparentCaption";

const rag: GlossaryTerm = {
  id: "rag",
  term: "RAG",
  english: "Retrieval-Augmented Generation",
  spokenAliases: ["레그"],
  easyExplanation: "외부 자료를 검색해 답변에 활용하는 방식",
  pageNumber: 3,
  occurrences: 1,
  source: "demo"
};

const correctedLine: TranscriptLine = {
  id: "line-1",
  text: "RAG와 RAG를 설명합니다.",
  rawText: "레그와 레그를 설명합니다.",
  termIds: ["rag"],
  corrections: [
    { originalText: "레그", correctedText: "RAG", termId: "rag", displayStart: 0, displayEnd: 3, reason: "spokenAlias" },
    { originalText: "레그", correctedText: "RAG", termId: "rag", displayStart: 5, displayEnd: 8, reason: "spokenAlias" }
  ]
};

describe("transparent caption correction", () => {
  it("keeps repeated corrections separate without corrupting surrounding text", () => {
    expect(buildCaptionDisplayParts(correctedLine.text, correctedLine.corrections)).toEqual([
      { kind: "correction", text: "RAG", correction: correctedLine.corrections[0] },
      { kind: "text", text: "와 " },
      { kind: "correction", text: "RAG", correction: correctedLine.corrections[1] },
      { kind: "text", text: "를 설명합니다." }
    ]);
  });

  it("renders a visible marker and accessible original-to-canonical explanation", () => {
    const html = renderToStaticMarkup(<TransparentCaption line={correctedLine} terms={[rag]} className="caption" />);

    expect(html).toContain("자동 정정");
    expect(html).toContain("레그 → RAG");
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="tooltip"');
  });

  it("ignores malformed or overlapping ranges instead of duplicating text", () => {
    const parts = buildCaptionDisplayParts("RAG 문장", [
      { originalText: "레그", correctedText: "RAG", termId: "rag", displayStart: 0, displayEnd: 3, reason: "spokenAlias" },
      { originalText: "래그", correctedText: "AG ", termId: "rag", displayStart: 1, displayEnd: 4, reason: "spokenAlias" }
    ]);

    expect(parts.map((part) => part.text).join("")).toBe("RAG 문장");
    expect(parts.filter((part) => part.kind === "correction")).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";
import type { GlossaryTerm } from "../types.js";
import { createTranscriptEvent, findTranscriptTermMatches } from "./caption.js";

const rag: GlossaryTerm = {
  id: "rag",
  term: "RAG",
  english: "Retrieval-Augmented Generation",
  spokenAliases: ["래그", "레그", "알에이지"],
  easyExplanation: "외부 자료를 검색해 답변에 활용하는 방식",
  pageNumber: 3,
  occurrences: 1,
  source: "demo"
};
const segment = { segmentId: "segment-1", revision: 1 };

describe("transparent final caption correction", () => {
  it("never rewrites or annotates interim captions", () => {
    expect(createTranscriptEvent("레그를 설명합니다", false, [rag], segment)).toEqual({
      type: "partial",
      ...segment,
      text: "레그를 설명합니다"
    });
  });

  it("corrects repeated aliases left-to-right while preserving raw text and occurrence order", () => {
    expect(createTranscriptEvent("레그와 래그를 비교합니다.", true, [rag], segment)).toEqual({
      type: "final",
      ...segment,
      text: "RAG와 RAG를 비교합니다.",
      rawText: "레그와 래그를 비교합니다.",
      detectedTerms: ["rag", "rag"],
      relatedPage: 3,
      corrections: [
        { originalText: "레그", correctedText: "RAG", termId: "rag", displayStart: 0, displayEnd: 3, reason: "spokenAlias" },
        { originalText: "래그", correctedText: "RAG", termId: "rag", displayStart: 5, displayEnd: 8, reason: "spokenAlias" }
      ]
    });
  });

  it("connects canonical and English forms without labeling them as corrections", () => {
    const event = createTranscriptEvent("RAG와 Retrieval-Augmented Generation", true, [rag], segment);

    expect(event.text).toBe("RAG와 Retrieval-Augmented Generation");
    expect(event.detectedTerms).toEqual(["rag", "rag"]);
    expect(event.corrections).toEqual([]);
  });

  it("does not match a short alias inside a longer Korean word", () => {
    expect(findTranscriptTermMatches("레그레이즈 운동", [rag])).toEqual([]);
    expect(findTranscriptTermMatches("레그는 기술입니다", [rag]).map((match) => match.term.id)).toEqual(["rag"]);
  });

  it("corrects a safe generated alias outside the fallback list", () => {
    const bert = {
      ...rag,
      id: "bert",
      term: "BERT",
      english: "",
      spokenAliases: ["버트"]
    };

    expect(createTranscriptEvent("버트를 사용합니다.", true, [bert], segment)).toMatchObject({
      text: "BERT를 사용합니다.",
      rawText: "버트를 사용합니다.",
      detectedTerms: ["bert"],
      corrections: [{ originalText: "버트", correctedText: "BERT", termId: "bert" }]
    });
  });

  it("does not correct a blocked common-word alias even when passed directly", () => {
    const api = {
      ...rag,
      id: "api",
      term: "API",
      english: "Application Programming Interface",
      spokenAliases: ["사과"]
    };

    expect(createTranscriptEvent("사과를 먹습니다.", true, [api], segment)).toEqual({
      type: "final",
      ...segment,
      text: "사과를 먹습니다.",
      rawText: "사과를 먹습니다.",
      detectedTerms: [],
      relatedPage: undefined,
      corrections: []
    });
  });

  it("does not correct ambiguous 레그 before a separate Korean word", () => {
    expect(createTranscriptEvent("레그 프레스를 합니다.", true, [rag], segment)).toEqual({
      type: "final",
      ...segment,
      text: "레그 프레스를 합니다.",
      rawText: "레그 프레스를 합니다.",
      detectedTerms: [],
      relatedPage: undefined,
      corrections: []
    });
    expect(createTranscriptEvent("레그는 기술입니다.", true, [rag], segment).text).toBe("RAG는 기술입니다.");
  });

  it("chooses the longest candidate and never creates overlapping replacements", () => {
    const short = { ...rag, id: "short", term: "생성형", english: "", spokenAliases: [] };
    const long = { ...rag, id: "long", term: "생성형 AI", english: "", spokenAliases: [] };
    const event = createTranscriptEvent("생성형 AI를 적용합니다", true, [short, long], segment);

    expect(event.text).toBe("생성형 AI를 적용합니다");
    expect(event.detectedTerms).toEqual(["long"]);
    expect(event.corrections).toHaveLength(0);
  });

  it("does not duplicate one source glyph when NFKC expands it into multiple matches", () => {
    const kilo = { ...rag, id: "kilo", term: "キロ", english: "", spokenAliases: [] };
    const meter = { ...rag, id: "meter", term: "メートル", english: "", spokenAliases: [] };
    const event = createTranscriptEvent("㌖", true, [kilo, meter], segment);

    expect(event.text).toBe("㌖");
    expect(event.rawText).toBe("㌖");
    expect(event.detectedTerms).toEqual(["kilo", "meter"]);
  });
});

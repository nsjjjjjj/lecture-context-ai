import { describe, expect, it } from "vitest";
import type { GlossaryTerm } from "../types.js";
import {
  sanitizeSpokenAliases,
  withSanitizedSpokenAliases,
  withValidatedSpokenAliases
} from "./spoken-aliases.js";

function term(overrides: Partial<GlossaryTerm> = {}): GlossaryTerm {
  return {
    id: "rag",
    term: "RAG",
    english: "Retrieval-Augmented Generation",
    spokenAliases: [],
    easyExplanation: "외부 자료를 검색해 답변에 활용하는 방식",
    pageNumber: 1,
    occurrences: 1,
    source: "heuristic",
    ...overrides
  };
}

describe("spoken alias validation", () => {
  it("adds curated RAG aliases and removes normalized duplicates", () => {
    expect(withValidatedSpokenAliases([term({ spokenAliases: [" 레그 ", "레그"] })])[0]?.spokenAliases)
      .toEqual(["레그", "래그", "알에이지"]);
  });

  it("covers the Korean pronunciations observed in the fixed-audio pilot", () => {
    const result = withValidatedSpokenAliases([
      term(),
      term({ id: "transformer", term: "Transformer", english: "Transformer" }),
      term({ id: "fine-tuning", term: "Fine-tuning", english: "Fine-tuning" }),
      term({ id: "phrase-set", term: "PhraseSet", english: "PhraseSet" })
    ]);

    expect(result.map((candidate) => candidate.spokenAliases)).toEqual([
      ["래그", "레그", "알에이지"],
      ["트랜스포머"],
      ["파인 튜닝"],
      ["프레이즈셋", "프레이즈 세트", "프레이저스 셋"]
    ]);
  });

  it("rejects non-Hangul forms, unsafe common words, and every alias for Korean-only terms", () => {
    expect(sanitizeSpokenAliases("전문용어", "", ["alias", "모델", "용어", "충분한별칭"])).toEqual([]);
  });

  it("rejects plausible-looking aliases that are not a reviewed term-pronunciation pair", () => {
    expect(sanitizeSpokenAliases("API", "Application Programming Interface", ["사과", "에이피아이"])).toEqual([]);
  });

  it("drops aliases shared by different terms or equal to another canonical term", () => {
    const result = withValidatedSpokenAliases([
      term({ id: "one", term: "RAG", english: "", spokenAliases: ["레그"] }),
      term({ id: "two", term: "Retrieval-Augmented Generation", english: "", spokenAliases: ["레그"] })
    ]);

    expect(result[0]?.spokenAliases).toEqual([]);
    expect(result[1]?.spokenAliases).toEqual([]);
  });

  it("sanitizes supplied aliases without silently adding reviewed aliases", () => {
    expect(withSanitizedSpokenAliases([term({ spokenAliases: [] })])[0]?.spokenAliases).toEqual([]);
    expect(withSanitizedSpokenAliases([term({ spokenAliases: [" 레그 ", "사과"] })])[0]?.spokenAliases)
      .toEqual(["레그"]);
  });
});

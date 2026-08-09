import { describe, expect, it } from "vitest";
import type { GlossaryTerm } from "../types.js";
import { sanitizeSpokenAliases, withValidatedSpokenAliases } from "./spoken-aliases.js";

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

  it("caps aliases at six after canonicalization", () => {
    expect(sanitizeSpokenAliases("Example", "", ["가나다", "라마바", "사아자", "차카타", "파하가", "나다라", "마바사"]))
      .toHaveLength(6);
  });

  it("drops aliases shared by different terms or equal to another canonical term", () => {
    const result = withValidatedSpokenAliases([
      term({ id: "one", term: "Alpha", english: "", spokenAliases: ["알파", "공유발음"] }),
      term({ id: "two", term: "Beta", english: "", spokenAliases: ["공유발음", "알파"] })
    ]);

    expect(result[0]?.spokenAliases).toEqual([]);
    expect(result[1]?.spokenAliases).toEqual([]);
  });
});

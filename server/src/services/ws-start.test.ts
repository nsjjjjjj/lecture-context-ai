import { describe, expect, it } from "vitest";
import type { GlossaryTerm } from "../types.js";
import { demoTerms } from "./demo.js";
import { resolveStartContext, sanitizeGlossaryTerms, sanitizePhraseSet } from "./ws-start.js";

function term(overrides: Partial<GlossaryTerm> = {}): GlossaryTerm {
  return {
    id: "rag",
    term: "RAG",
    english: "Retrieval-Augmented Generation",
    spokenAliases: ["래그", "레그", "알에이지"],
    easyExplanation: "외부 자료를 찾아 답변에 활용하는 방식",
    pageNumber: 1,
    occurrences: 1,
    source: "heuristic",
    ...overrides
  };
}

describe("sanitizeGlossaryTerms", () => {
  it("유효한 용어만 정규화 기준으로 중복 제거하고 50개로 제한한다", () => {
    const candidates = [term(), term({ id: "duplicate", term: "ＲＡＧ" })];
    for (let index = 0; index < 60; index += 1) {
      candidates.push(term({ id: `term-${index}`, term: `Term ${index}` }));
    }
    candidates.push({ broken: true } as unknown as GlossaryTerm);

    const result = sanitizeGlossaryTerms(candidates);

    expect(result).toHaveLength(50);
    expect(result[0]?.term).toBe("RAG");
    expect(result.some((candidate) => candidate.id === "duplicate")).toBe(false);
  });

  it("발음 별칭을 안전 규칙으로 정리하고 알려진 RAG 발음을 보완한다", () => {
    const result = sanitizeGlossaryTerms([
      term({ spokenAliases: [" 레그 ", "모델", "not-korean", "레그"] })
    ]);

    expect(result[0]?.spokenAliases).toEqual(["레그", "래그", "알에이지"]);
  });

  it("공백뿐인 용어는 거부하고 허용한 용어와 영문 표기는 정규화된 값으로 반환한다", () => {
    const result = sanitizeGlossaryTerms([
      term({ id: "blank", term: "  ", english: "  " }),
      term({ term: "  ＲＡＧ  ", english: "  Retrieval-Augmented   Generation  " })
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      term: "RAG",
      english: "Retrieval-Augmented Generation"
    });
  });
});

describe("sanitizePhraseSet", () => {
  it("검증된 term과 english에 대응하는 표기만 정규화 기준으로 허용한다", () => {
    const result = sanitizePhraseSet(
      [" rag ", "ＲＡＧ", " retrieval-augmented   generation ", " 레그 ", "없는 용어", 123],
      [term()]
    );

    expect(result).toEqual(["RAG", "Retrieval-Augmented Generation", "레그"]);
  });

  it("허용된 표기가 많아도 PhraseSet을 50개로 제한한다", () => {
    const terms = Array.from({ length: 60 }, (_, index) =>
      term({ id: `term-${index}`, term: `Term ${index}`, english: "" })
    );

    expect(sanitizePhraseSet(terms.map((candidate) => candidate.term), terms)).toHaveLength(50);
  });

  it("과도하게 큰 문자열과 너무 짧은 표기는 정규화 대상에서 제외한다", () => {
    const result = sanitizePhraseSet(["R".repeat(10_000), "R", "RAG"], [
      term(),
      term({ id: "short", term: "Short term", english: "R" })
    ]);

    expect(result).toEqual(["RAG"]);
  });

  it("원시 후보 검사량을 PhraseSet 상한의 합리적인 배수로 제한한다", () => {
    const candidates = [...Array.from({ length: 200 }, () => null), "RAG"];

    expect(sanitizePhraseSet(candidates, [term()])).toEqual([]);
  });
});

describe("resolveStartContext", () => {
  it("live 모드는 빈 입력을 데모 데이터로 대체하지 않는다", () => {
    expect(resolveStartContext("live", [], ["RAG"])).toEqual({ mode: "live", terms: [], phraseSet: [] });
  });

  it("demo 모드만 빈 용어를 내장 데모 용어로 대체한다", () => {
    const context = resolveStartContext("demo", [], []);

    expect(context.terms).toEqual(demoTerms);
    expect(context.phraseSet).toEqual([]);
  });

  it("live 모드에서 허용된 PhraseSet을 STT 입력용 데이터로 보존한다", () => {
    const context = resolveStartContext("live", [term()], ["Retrieval-Augmented Generation"]);

    expect(context.terms).toEqual([term()]);
    expect(context.phraseSet).toEqual(["Retrieval-Augmented Generation"]);
  });
});

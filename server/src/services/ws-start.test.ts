import { describe, expect, it } from "vitest";
import type { GlossaryTerm } from "../types.js";
import { createTranscriptEvent } from "./caption.js";
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

  it("제공된 안전한 자동 발음만 정리하고 알려진 별칭도 몰래 보완하지 않는다", () => {
    const result = sanitizeGlossaryTerms([
      term({ spokenAliases: [" 레그 ", "모델", "not-korean", "레그"] })
    ]);

    expect(result[0]?.spokenAliases).toEqual(["레그"]);
  });

  it("고정 목록에 없는 안전한 자동 발음을 WebSocket 경계에서 보존한다", () => {
    const result = sanitizeGlossaryTerms([
      term({ id: "bert", term: "BERT", english: "", spokenAliases: ["버트"] })
    ]);

    expect(result[0]?.spokenAliases).toEqual(["버트"]);
    expect(sanitizePhraseSet(["BERT", "버트"], result)).toEqual(["BERT", "버트"]);
  });

  it("중복 ID는 첫 번째 유효 용어만 보존해 canonical term과 소유권을 일치시킨다", () => {
    const result = sanitizeGlossaryTerms([
      term({ id: "shared", term: "RAG", english: "Retrieval-Augmented Generation", spokenAliases: ["레그"] }),
      term({ id: "shared", term: "LLM", english: "Large Language Model", spokenAliases: ["엘엘엠"] })
    ]);

    expect(result).toEqual([
      term({ id: "shared", term: "RAG", english: "Retrieval-Augmented Generation", spokenAliases: ["레그"] })
    ]);
    expect(createTranscriptEvent("레그는 기술입니다.", true, result, { segmentId: "segment-1", revision: 1 })).toMatchObject({
      text: "RAG는 기술입니다.",
      detectedTerms: ["shared"],
      corrections: [{ originalText: "레그", correctedText: "RAG", termId: "shared" }]
    });
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

  it("원본 용어 50개에 딸린 한글 발음은 50개 제한에 포함하지 않는다", () => {
    const terms = sanitizeGlossaryTerms(Array.from({ length: 50 }, (_, index) =>
      term({
        id: `term-${index}`,
        term: `Term ${index}`,
        english: "",
        spokenAliases: [`${String.fromCharCode(0xac00 + index)}음`]
      })
    ));
    const phrases = terms.flatMap((candidate) => [candidate.term, ...candidate.spokenAliases]);

    expect(sanitizePhraseSet(phrases, terms)).toHaveLength(100);
    expect(sanitizePhraseSet(phrases, terms)).toContain(`${String.fromCharCode(0xac00 + 49)}음`);
  });

  it("원본 용어가 50개로 정리된 뒤에는 허용되지 않은 추가 표기를 제외한다", () => {
    const rawTerms = Array.from({ length: 60 }, (_, index) =>
      term({ id: `term-${index}`, term: `Term ${index}`, english: "", spokenAliases: [] })
    );
    const terms = sanitizeGlossaryTerms(rawTerms);

    expect(sanitizePhraseSet(rawTerms.map((candidate) => candidate.term), terms)).toEqual(
      terms.map((candidate) => candidate.term)
    );
  });

  it("과도하게 큰 문자열과 너무 짧은 표기는 정규화 대상에서 제외한다", () => {
    const result = sanitizePhraseSet(["R".repeat(10_000), "R", "RAG"], [
      term(),
      term({ id: "short", term: "Short term", english: "R" })
    ]);

    expect(result).toEqual(["RAG"]);
  });

  it("원시 후보 검사량을 PhraseSet 상한의 합리적인 배수로 제한한다", () => {
    const candidates = [...Array.from({ length: 1_600 }, () => null), "RAG"];

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

  it("v1에서 이전된 빈 별칭과 기존 PhraseSet을 끝까지 그대로 유지한다", () => {
    const legacyTerm = term({ spokenAliases: [] });
    const context = resolveStartContext("live", [legacyTerm], ["RAG", "Retrieval-Augmented Generation", "레그"]);

    expect(context.terms).toEqual([legacyTerm]);
    expect(context.phraseSet).toEqual(["RAG", "Retrieval-Augmented Generation"]);
  });
});

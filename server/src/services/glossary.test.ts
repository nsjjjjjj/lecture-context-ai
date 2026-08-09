import { afterEach, describe, expect, it, vi } from "vitest";
import type { GlossaryTerm, PageText } from "../types.js";
import { analyzeGlossary, buildPhraseSet, matchTerms } from "./glossary.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const pages: PageText[] = [
  { pageNumber: 1, text: "오늘은 생성형 AI와 RAG를 소개합니다." },
  { pageNumber: 2, text: "RAG는 Retrieval-Augmented Generation의 약자입니다." }
];

const terms: GlossaryTerm[] = [
  {
    id: "rag",
    term: "RAG",
    english: "Retrieval-Augmented Generation",
    spokenAliases: ["래그", "레그", "알에이지"],
    easyExplanation: "외부 문서를 검색한 뒤 답변을 만드는 방식",
    pageNumber: 1,
    occurrences: 2,
    source: "heuristic"
  },
  {
    id: "missing",
    term: "LangChain",
    english: "LangChain",
    spokenAliases: ["랭체인", "랑체인"],
    easyExplanation: "언어 모델 앱 개발 도구",
    pageNumber: 1,
    occurrences: 0,
    source: "heuristic"
  }
];

describe("buildPhraseSet", () => {
  it("PDF에 존재하는 영문 확장 표현만 PhraseSet에 추가한다", () => {
    expect(buildPhraseSet(terms, pages)).toEqual([
      "RAG",
      "래그",
      "레그",
      "알에이지",
      "Retrieval-Augmented Generation"
    ]);
  });

  it("안전한 자동 생성 발음은 허용하고 차단된 일반 단어는 PhraseSet에서 제외한다", () => {
    const bert = {
      ...terms[0],
      id: "bert",
      term: "BERT",
      english: "Bidirectional Encoder Representations from Transformers",
      spokenAliases: ["버트"]
    };
    const api = {
      ...terms[0],
      id: "api",
      term: "API",
      english: "Application Programming Interface",
      spokenAliases: ["사과"]
    };
    const apiPages = [{ pageNumber: 1, text: "BERT와 API를 소개합니다." }];

    expect(buildPhraseSet([bert, api], apiPages)).toEqual(["BERT", "버트", "API"]);
  });

  it("원본 용어 50개 제한과 별개로 영문·한글 발음 표기를 모두 보존한다", () => {
    const manyTerms = Array.from({ length: 20 }, (_, index): GlossaryTerm => ({
      id: `term-${index}`,
      term: `Term${index}`,
      english: `English${index}`,
      spokenAliases: [`${String.fromCharCode(0xac00 + index)}음`],
      easyExplanation: `용어 ${index} 설명`,
      pageNumber: 1,
      occurrences: 1,
      source: "gemini"
    }));
    const manyPages = [{
      pageNumber: 1,
      text: manyTerms.flatMap((term) => [term.term, term.english]).join(" ")
    }];

    const phraseSet = buildPhraseSet(manyTerms, manyPages);

    expect(phraseSet).toHaveLength(60);
    expect(phraseSet).toContain("Term19");
    expect(phraseSet).toContain("English19");
    expect(phraseSet).toContain(`${String.fromCharCode(0xac00 + 19)}음`);
  });
});

describe("analyzeGlossary", () => {
  it("검증된 Gemini 용어가 3개 미만이어도 보존하고 휴리스틱 용어로 보완한다", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        terms: [{
          term: "BERT",
          english: "",
          spokenAliases: ["버트"],
          easyExplanation: "문맥을 양방향으로 이해하는 언어 모델"
        }]
      }) }] } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const result = await analyzeGlossary("소규모 PDF", [{ pageNumber: 1, text: "BERT와 Transformer를 비교합니다." }]);

    expect(result.terms).toEqual(expect.arrayContaining([
      expect.objectContaining({ term: "BERT", spokenAliases: ["버트"], source: "gemini" }),
      expect.objectContaining({ term: "Transformer", spokenAliases: ["트랜스포머"], source: "heuristic" })
    ]));
    expect(result.phraseSet).toEqual(expect.arrayContaining(["BERT", "버트", "Transformer", "트랜스포머"]));
    expect(result.warning).toContain("1개만 반환해");
  });
});

describe("matchTerms", () => {
  it("확정 자막에서 대소문자와 무관하게 용어를 찾는다", () => {
    expect(matchTerms("이번에는 rag를 사용합니다.", terms).map((term) => term.id)).toEqual(["rag"]);
  });

  it("한글 발음 별칭도 canonical 용어의 반복 출현으로 찾는다", () => {
    expect(matchTerms("레그와 알에이지를 비교합니다.", terms).map((term) => term.id)).toEqual(["rag", "rag"]);
  });

  it("같은 final 안의 반복 용어를 실제 출현 순서대로 모두 반환한다", () => {
    expect(matchTerms("RAG를 설명한 뒤 RAG와 LangChain을 비교합니다.", terms).map((term) => term.id)).toEqual([
      "rag",
      "rag",
      "missing"
    ]);
  });

  it("같은 위치에서 시작하거나 겹치는 용어는 가장 긴 표기 하나만 선택한다", () => {
    const overlappingTerms: GlossaryTerm[] = [
      { ...terms[0], id: "ai", term: "AI" },
      { ...terms[0], id: "generative-ai", term: "생성형 AI" }
    ];

    expect(matchTerms("생성형 AI와 AI를 비교합니다.", overlappingTerms).map((term) => term.id)).toEqual([
      "generative-ai",
      "ai"
    ]);
  });

  it("ASCII 단어 내부의 부분 문자열은 막고 한국어 조사가 붙은 용어는 인식한다", () => {
    const asciiTerms: GlossaryTerm[] = [
      { ...terms[0], id: "ai", term: "AI" },
      { ...terms[0], id: "rag", term: "RAG" }
    ];

    expect(matchTerms("daily 모델과 AI는 다르고 RAG를 사용합니다.", asciiTerms).map((term) => term.id)).toEqual([
      "ai",
      "rag"
    ]);
  });

  it("정규화 뒤 빈 용어는 건너뛰고 탐색을 종료한다", () => {
    const emptyTerm = { ...terms[0], id: "empty", term: "   " };

    expect(matchTerms("RAG", [emptyTerm])).toEqual([]);
  });

  it("문맥 독립 소문자화로 Greek final sigma 위치를 클라이언트와 동일하게 찾는다", () => {
    const sigma = { ...terms[0], id: "sigma", term: "Σ" };

    expect(matchTerms("ΟΣ", [sigma]).map((term) => term.id)).toEqual(["sigma"]);
  });

  it("하나의 NFKC 호환문자 안에서 순차로 등장한 용어를 모두 찾는다", () => {
    const compatibilityTerms: GlossaryTerm[] = [
      { ...terms[0], id: "kilo", term: "キロ" },
      { ...terms[0], id: "meter", term: "メートル" }
    ];

    expect(matchTerms("㌖", compatibilityTerms).map((term) => term.id)).toEqual(["kilo", "meter"]);
  });
});

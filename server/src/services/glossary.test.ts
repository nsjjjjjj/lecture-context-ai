import { describe, expect, it } from "vitest";
import type { GlossaryTerm, PageText } from "../types.js";
import { buildPhraseSet, matchTerms } from "./glossary.js";

const pages: PageText[] = [
  { pageNumber: 1, text: "오늘은 생성형 AI와 RAG를 소개합니다." },
  { pageNumber: 2, text: "RAG는 Retrieval-Augmented Generation의 약자입니다." }
];

const terms: GlossaryTerm[] = [
  {
    id: "rag",
    term: "RAG",
    english: "Retrieval-Augmented Generation",
    easyExplanation: "외부 문서를 검색한 뒤 답변을 만드는 방식",
    pageNumber: 1,
    occurrences: 2,
    source: "heuristic"
  },
  {
    id: "missing",
    term: "LangChain",
    english: "LangChain",
    easyExplanation: "언어 모델 앱 개발 도구",
    pageNumber: 1,
    occurrences: 0,
    source: "heuristic"
  }
];

describe("buildPhraseSet", () => {
  it("PDF에 존재하는 영문 확장 표현만 PhraseSet에 추가한다", () => {
    expect(buildPhraseSet(terms, pages)).toEqual(["RAG", "Retrieval-Augmented Generation"]);
  });
});

describe("matchTerms", () => {
  it("확정 자막에서 대소문자와 무관하게 용어를 찾는다", () => {
    expect(matchTerms("이번에는 rag를 사용합니다.", terms).map((term) => term.id)).toEqual(["rag"]);
  });
});

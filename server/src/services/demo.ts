import type { GlossaryTerm, PageText } from "../types.js";

export const demoPages: PageText[] = [
  {
    pageNumber: 1,
    text: "생성형 AI 강연: LLM과 Transformer의 기본 원리를 이해합니다."
  },
  {
    pageNumber: 2,
    text: "LLM은 대규모 언어 모델입니다. Transformer 구조를 활용해 문맥을 처리합니다."
  },
  {
    pageNumber: 3,
    text: "RAG는 Retrieval-Augmented Generation의 약자입니다. 외부 문서를 검색해 AI 환각을 줄입니다."
  },
  {
    pageNumber: 4,
    text: "파인튜닝은 기존 모델을 목적에 맞는 데이터로 추가 학습하는 과정입니다."
  }
];

export const demoTerms: GlossaryTerm[] = [
  {
    id: "demo-rag",
    term: "RAG",
    english: "Retrieval-Augmented Generation",
    spokenAliases: ["래그", "레그", "알에이지"],
    easyExplanation: "외부 문서를 먼저 검색한 뒤 근거를 바탕으로 답변을 만드는 방식입니다.",
    pageNumber: 3,
    occurrences: 1,
    source: "demo"
  },
  {
    id: "demo-llm",
    term: "LLM",
    english: "Large Language Model",
    spokenAliases: ["엘엘엠"],
    easyExplanation: "대량의 텍스트를 학습해 사람의 언어를 이해하고 생성하는 모델입니다.",
    pageNumber: 2,
    occurrences: 2,
    source: "demo"
  },
  {
    id: "demo-transformer",
    term: "Transformer",
    english: "Transformer",
    spokenAliases: ["트랜스포머"],
    easyExplanation: "문장 속 단어들의 관계를 한 번에 살펴 문맥을 이해하는 신경망 구조입니다.",
    pageNumber: 2,
    occurrences: 2,
    source: "demo"
  },
  {
    id: "demo-finetuning",
    term: "파인튜닝",
    english: "Fine-tuning",
    spokenAliases: ["파인 튜닝"],
    easyExplanation: "이미 학습된 AI를 특정 목적에 맞게 추가로 학습하는 방법입니다.",
    pageNumber: 4,
    occurrences: 1,
    source: "demo"
  },
  {
    id: "demo-hallucination",
    term: "환각",
    english: "Hallucination",
    spokenAliases: [],
    easyExplanation: "AI가 사실이 아닌 내용을 그럴듯하게 생성하는 현상입니다.",
    pageNumber: 3,
    occurrences: 1,
    source: "demo"
  }
];

export const demoTranscript = [
  { interim: "오늘은 대규모 언어 모델을", final: "오늘은 LLM과 Transformer의 기본 원리를 살펴보겠습니다." },
  { interim: "알에이지는 외부 문서를", final: "레그는 외부 문서를 검색해 답변의 근거를 보강합니다." },
  { interim: "이 방식은 인공지능의", final: "이 방식은 생성형 AI의 환각을 줄이는 데 도움이 됩니다." },
  { interim: "필요한 경우 파인", final: "필요한 경우 파인튜닝으로 모델을 목적에 맞게 조정할 수 있습니다." }
];

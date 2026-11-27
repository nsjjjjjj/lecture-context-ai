import { afterEach, describe, expect, it, vi } from "vitest";
import type { GlossaryTerm, PageText } from "../types.js";
import {
  analyzeGlossary,
  buildGeminiPrompt,
  buildPhraseSet,
  GlossaryAnalysisCancelledError,
  matchTerms
} from "./glossary.js";

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

describe("buildGeminiPrompt", () => {
  it("12만 자 안에서 모든 페이지의 앞뒤를 균형 있게 보존한다", () => {
    const longPages = [
      { pageNumber: 1, text: `ONE_HEAD ${"가".repeat(60_000)} ONE_TAIL` },
      { pageNumber: 2, text: `TWO_HEAD ${"나".repeat(60_000)} TWO_TAIL` },
      { pageNumber: 3, text: `THREE_HEAD ${"다".repeat(60_000)} THREE_TAIL` }
    ];

    const result = buildGeminiPrompt(longPages);

    expect(buildGeminiPrompt(longPages)).toEqual(result);
    expect(result.prompt.length).toBeLessThanOrEqual(120_000);
    expect(result.wasTruncated).toBe(true);
    expect(result.truncatedPageNumbers).toEqual([1, 2, 3]);
    for (const [pageNumber, head, tail] of [
      [1, "ONE_HEAD", "ONE_TAIL"],
      [2, "TWO_HEAD", "TWO_TAIL"],
      [3, "THREE_HEAD", "THREE_TAIL"]
    ] as const) {
      expect(result.prompt).toContain(`[PDF ${pageNumber}페이지]`);
      expect(result.prompt).toContain(head);
      expect(result.prompt).toContain(tail);
    }
    expect(result.prompt.match(/\[페이지 가운데 일부 생략\]/gu)).toHaveLength(3);
  });

  it("예산 안의 짧은 페이지는 변경하지 않는다", () => {
    const result = buildGeminiPrompt(pages);

    expect(result.wasTruncated).toBe(false);
    expect(result.truncatedPageNumbers).toEqual([]);
    expect(result.prompt).toContain(pages[0].text);
    expect(result.prompt).toContain(pages[1].text);
  });
});

describe("analyzeGlossary", () => {
  it("AI를 쓸 수 없는 비한국어 문서에서는 대문자를 전문용어로 임의 추출하지 않는다", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");

    const result = await analyzeGlossary("English material", [{
      pageNumber: 1,
      text: "IMPORTANT CUSTOMER DATA AND WEEKLY STATUS REPORT"
    }]);

    expect(result.mode).toBe("heuristic");
    expect(result.terms).toEqual([]);
    expect(result.phraseSet).toEqual([]);
    expect(result.warning).toContain("한국어 강연 자료에서만 지원");
    expect(result.warning).toContain("임의 추출하지 않았습니다");
  });

  it("AI를 쓸 수 없는 한국어 문서에서는 보수적인 표기 후보만 추출한다고 알린다", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");

    const result = await analyzeGlossary("한국어 자료", [{
      pageNumber: 1,
      text: "오늘은 RAG를 활용하는 검색 증강 방식을 소개합니다."
    }]);

    expect(result.terms).toContainEqual(expect.objectContaining({ term: "RAG", source: "heuristic" }));
    expect(result.warning).toContain("한국어 문서 내 표기 기반으로 추출");
  });

  it("AI를 쓸 수 없는 한국어 전용 문서에서도 기술 복합명사를 보수적으로 복구한다", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");

    const result = await analyzeGlossary("한국어 기술 자료", [{
      pageNumber: 1,
      text: "자기지도학습과 검색증강생성은 대규모언어모델에서 활용됩니다."
    }]);

    expect(result.mode).toBe("heuristic");
    expect(result.terms.map((term) => term.term)).toEqual(expect.arrayContaining([
      "자기지도학습",
      "검색증강생성",
      "대규모언어모델"
    ]));
    expect(result.warning).toContain("한국어 문서 내 표기 기반으로 추출");
  });

  it("caller가 요청을 끊으면 Gemini를 중단하고 heuristic 성공으로 가장하지 않는다", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const analysis = analyzeGlossary("취소 검사", [{
      pageNumber: 1,
      text: "오늘은 RAG를 활용하는 방식을 소개합니다."
    }], { signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    controller.abort();

    await expect(analysis).rejects.toBeInstanceOf(GlossaryAnalysisCancelledError);
  });

  it("Gemini 자체 timeout은 caller 취소와 달리 한국어 heuristic fallback으로 복구한다", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("GEMINI_TIMEOUT_MS", "1");
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })));

    const result = await analyzeGlossary("timeout 검사", [{
      pageNumber: 1,
      text: "오늘은 RAG를 활용하는 방식을 소개합니다."
    }]);

    expect(result.mode).toBe("heuristic");
    expect(result.terms).toContainEqual(expect.objectContaining({ term: "RAG" }));
    expect(result.warning).toContain("AI 분석 시간이 초과");
  });

  it("검증된 Gemini 용어가 3개 미만이어도 보존하고 휴리스틱 용어로 보완한다", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        terms: [{
          term: "BERT",
          english: "",
          spokenAliases: ["버트"],
          easyExplanation: "문맥을 양방향으로 이해하는 언어 모델입니다."
        }]
      }) }] } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const result = await analyzeGlossary("소규모 PDF", [{ pageNumber: 1, text: "BERT와 Transformer를 비교합니다." }]);

    expect(result.terms).toEqual(expect.arrayContaining([
      expect.objectContaining({
        term: "BERT",
        spokenAliases: ["버트"],
        easyExplanation: "문맥을 양방향으로 이해하는 언어 모델",
        source: "gemini"
      }),
      expect.objectContaining({ term: "Transformer", spokenAliases: ["트랜스포머"], source: "heuristic" })
    ]));
    expect(result.phraseSet).toEqual(expect.arrayContaining(["BERT", "버트", "Transformer", "트랜스포머"]));
    expect(result.warning).toContain("1개만 반환해");
  });

  it("ASCII 단어 내부 부분 문자열을 PDF 근거로 오인하지 않는다", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        terms: [
          { term: "AI", english: "Artificial Intelligence", spokenAliases: [], easyExplanation: "인공지능 기술" },
          { term: "RAG", english: "Retrieval-Augmented Generation", spokenAliases: [], easyExplanation: "검색 증강 기술" }
        ]
      }) }] } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const result = await analyzeGlossary("경계 검사", [{ pageNumber: 1, text: "daily storage" }]);

    expect(result.terms).toEqual([]);
    expect(result.phraseSet).toEqual([]);
  });

  it("PDF에 없는 영문 확장 표기는 버리고 canonical 표기만 보존한다", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        terms: [{
          term: "RAG",
          english: "Wrong Expansion",
          spokenAliases: ["래그"],
          easyExplanation: "검색 결과를 활용하는 기술"
        }]
      }) }] } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const result = await analyzeGlossary("영문 근거", [{ pageNumber: 1, text: "RAG를 소개합니다." }]);

    expect(result.terms[0]).toMatchObject({ term: "RAG", english: "" });
    expect(result.phraseSet).not.toContain("Wrong Expansion");
  });

  it("Gemini key를 URL이 아닌 header로 보내고 upstream 본문을 사용자 warning에 노출하지 않는다", async () => {
    vi.stubEnv("GEMINI_API_KEY", "sensitive-test-key");
    vi.stubEnv("GEMINI_MODEL", "");
    vi.stubEnv("GEMINI_THINKING_LEVEL", "");
    const fetchMock = vi.fn().mockResolvedValue(new Response("upstream-sensitive-body", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeGlossary("요청 안전성", [{ pageNumber: 1, text: "RAG를 소개합니다." }]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const requestBody = JSON.parse(String(init.body)) as {
      generationConfig?: { thinkingConfig?: { thinkingLevel?: string } };
    };

    expect(url).not.toContain("sensitive-test-key");
    expect(url).toContain("/models/gemini-3.7-flash:generateContent");
    expect(new Headers(init.headers).get("x-goog-api-key")).toBe("sensitive-test-key");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(requestBody.generationConfig?.thinkingConfig?.thinkingLevel).toBe("low");
    expect(result.warning).not.toContain("upstream-sensitive-body");
    expect(result.warning).not.toContain("sensitive-test-key");
  });

  it("긴 자료도 마지막 페이지까지 한 요청에 포함하고 줄인 페이지를 사용자에게 알린다", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        terms: [
          { term: "FIRSTTERM", english: "", spokenAliases: ["퍼스트텀"], easyExplanation: "첫 번째 전문 개념" },
          { term: "SECONDTERM", english: "", spokenAliases: ["세컨드텀"], easyExplanation: "두 번째 전문 개념" },
          { term: "MIDDLETERM", english: "", spokenAliases: ["미들텀"], easyExplanation: "가운데 전문 개념" }
        ]
      }) }] } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const longPages = [
      { pageNumber: 1, text: `FIRSTTERM ${"가".repeat(70_000)} PAGE_ONE_TAIL` },
      {
        pageNumber: 2,
        text: `SECONDTERM ${"나".repeat(35_000)} MIDDLETERM HIDDENTERM ${"나".repeat(35_000)} PAGE_TWO_TAIL`
      }
    ];

    const result = await analyzeGlossary("긴 강연", longPages);
    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    const requestBody = JSON.parse(String(request.body)) as {
      contents: Array<{ parts: Array<{ text: string }> }>;
    };
    const prompt = requestBody.contents[0].parts[0].text;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(prompt.length).toBeLessThanOrEqual(120_000);
    expect(prompt).toContain("[PDF 1페이지]");
    expect(prompt).toContain("PAGE_ONE_TAIL");
    expect(prompt).toContain("[PDF 2페이지]");
    expect(prompt).toContain("PAGE_TWO_TAIL");
    expect(prompt).not.toContain("MIDDLETERM");
    expect(prompt).not.toContain("HIDDENTERM");
    expect(result.mode).toBe("gemini");
    expect(result.terms.map((term) => term.term)).toEqual(expect.arrayContaining([
      "FIRSTTERM",
      "SECONDTERM",
      "MIDDLETERM",
      "HIDDENTERM"
    ]));
    expect(result.terms).toContainEqual(expect.objectContaining({ term: "HIDDENTERM", source: "heuristic" }));
    expect(result.warning).toContain("1페이지, 2페이지");
    expect(result.warning).toContain("전체 추출 텍스트");
    expect(result.warning).toContain("표기 기반 후보를 1개 추가");
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

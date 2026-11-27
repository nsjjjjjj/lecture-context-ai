import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNonEmptyGlossary } from "../app-state";
import type { StoredGlossary } from "./glossary-storage";
import { analyzePdf, createExperimentCase, getDemo, getHealth, prepareAwsVocabulary } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("experiment case API", () => {
  it("sends only the glossary fields accepted by the strict server schema", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ experimentCase: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const glossary: StoredGlossary = {
      id: "glossary-1",
      name: "PDF 용어집",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T01:00:00.000Z",
      terms: [{
        id: "term-rag",
        term: "RAG",
        english: "Retrieval-Augmented Generation",
        spokenAliases: ["래그"],
        easyExplanation: "검색 결과로 답변 근거를 보강하는 방식",
        pageNumber: 1,
        occurrences: 1,
        source: "gemini"
      }],
      phraseSet: ["RAG", "래그"]
    };

    await createExperimentCase("study-1", {
      title: "PDF 실험",
      scriptText: "래그를 설명합니다.",
      glossary,
      targetTerms: [{
        canonicalTerm: "RAG",
        english: "Retrieval-Augmented Generation",
        spokenAliases: ["래그"]
      }]
    });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(options.body)) as Record<string, unknown> & {
      glossary: Record<string, unknown>;
    };
    expect(url).toBe("/api/dev/experiment-studies/study-1/cases");
    expect(options.method).toBe("POST");
    expect(body.glossary).toEqual({
      id: glossary.id,
      name: glossary.name,
      updatedAt: glossary.updatedAt,
      terms: glossary.terms
    });
    expect(body.glossary).not.toHaveProperty("createdAt");
    expect(body.glossary).not.toHaveProperty("phraseSet");
  });
});

describe("public API runtime contracts", () => {
  it("설정 여부와 실제 동작 검증 상태를 별도 health 필드로 검증한다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      sttProvider: "aws",
      services: {
        speech: { configured: true, verification: "unverified" },
        customVocabulary: { configured: false, verification: "unverified" },
        gemini: false
      }
    }), { status: 200 })));

    await expect(getHealth()).resolves.toEqual({
      ok: true,
      sttProvider: "aws",
      services: {
        speech: { configured: true, verification: "unverified" },
        customVocabulary: { configured: false, verification: "unverified" },
        gemini: false
      }
    });
  });

  it("rejects a malformed analysis instead of publishing it to the ready screen", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      title: "broken",
      pages: [{ pageNumber: 1, text: "page" }],
      terms: [{ id: "term-with-missing-fields" }],
      phraseSet: [],
      mode: "demo"
    }), { status: 200 })));

    await expect(getDemo()).rejects.toThrow("분석 결과 형식");
  });

  it("accepts a fail-closed empty analysis response and lets the app show the semantic empty-result message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      title: "일반 문장 자료",
      terms: [],
      phraseSet: [],
      mode: "heuristic",
      warning: "검증 가능한 전문용어를 찾지 못했습니다."
    }), { status: 200 })));
    const pages = [{ pageNumber: 1, text: "오늘의 일정을 안내합니다." }];

    const analysis = await analyzePdf("일반 문장 자료", pages);

    expect(analysis).toMatchObject({ terms: [], phraseSet: [], pages });
    expect(() => requireNonEmptyGlossary(analysis)).toThrow(
      "PDF에서 저장할 전문용어를 찾지 못했습니다. 전문용어가 포함된 자료를 사용해 주세요."
    );
  });

  it("rejects health and vocabulary responses whose fields only look typed at compile time", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        services: { speech: { configured: true, verification: "probably" }, gemini: false }
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ vocabularyName: "other-account-vocabulary", hash: "short", reused: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getHealth()).rejects.toThrow("상태 응답 형식");
    await expect(prepareAwsVocabulary([])).rejects.toThrow("AWS 용어집 응답 형식");
  });

  it("turns a non-JSON server error into a recoverable status message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Bad gateway", { status: 502 })));

    await expect(getHealth()).rejects.toThrow("서버 요청에 실패했습니다. (502)");
  });
});

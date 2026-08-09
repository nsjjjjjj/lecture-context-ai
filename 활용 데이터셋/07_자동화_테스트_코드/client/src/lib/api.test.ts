import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredGlossary } from "./glossary-storage";
import { createExperimentCase } from "./api";

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

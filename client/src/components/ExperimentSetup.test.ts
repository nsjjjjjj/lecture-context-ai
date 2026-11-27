import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ExperimentStudy } from "../lib/api";
import type { StoredGlossary } from "../lib/glossary-storage";
import { ExperimentSetup, parseManualTargetTerms } from "./ExperimentSetup";

describe("experiment setup manual gold targets", () => {
  it("parses one target per line without turning it into a PDF adaptation term", () => {
    expect(parseManualTargetTerms("LoRA | Low-Rank Adaptation |\nRAG | Retrieval-Augmented Generation | 래그, 레그")).toEqual([
      { canonicalTerm: "LoRA", english: "Low-Rank Adaptation", spokenAliases: [] },
      { canonicalTerm: "RAG", english: "Retrieval-Augmented Generation", spokenAliases: ["래그", "레그"] }
    ]);
  });

  it("exposes named, labelled controls with visible keyboard focus and a semantic loading status", () => {
    const glossary: StoredGlossary = {
      id: "glossary-1",
      name: "발표 용어집",
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
      terms: [{
        id: "term-1",
        term: "RAG",
        english: "Retrieval-Augmented Generation",
        spokenAliases: ["래그"],
        easyExplanation: "검색 결과를 활용하는 생성 방식",
        pageNumber: 1,
        occurrences: 1,
        source: "gemini"
      }],
      phraseSet: ["RAG", "래그"]
    };
    const study: ExperimentStudy = {
      id: "study-1",
      title: "STT 실험",
      createdAt: "2026-08-29T00:00:00.000Z",
      cases: []
    };
    const html = renderToStaticMarkup(createElement(ExperimentSetup, {
      glossaries: [glossary],
      studies: [study],
      loading: true,
      error: "",
      onChanged: async () => undefined,
      onContinue: () => undefined
    }));

    expect(html).toContain('for="experiment-study-title"');
    expect(html).toContain('name="experimentStudyTitle"');
    expect(html).toContain('name="experimentStudyId"');
    expect(html).toContain('name="experimentGlossaryId"');
    expect(html).toContain('name="experimentCaseTitle"');
    expect(html).toContain('name="experimentScriptText"');
    expect(html).toContain('name="experimentTargetTermIds"');
    expect(html).toContain('name="experimentManualTargets"');
    expect(html).toContain("focus-visible:ring-2");
    expect(html).toMatch(/role="status"[^>]*>.*저장 목록 갱신 중/s);
  });
});

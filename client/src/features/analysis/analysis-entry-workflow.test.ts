import { describe, expect, it, vi } from "vitest";
import type { AnalysisResult } from "../../types";
import { runAnalysisEntryWorkflow } from "./analysis-entry-workflow";

const analysis: AnalysisResult = {
  title: "샘플",
  pages: [{ pageNumber: 1, text: "RAG" }],
  terms: [{
    id: "rag",
    term: "RAG",
    english: "Retrieval-Augmented Generation",
    spokenAliases: ["래그"],
    easyExplanation: "검색 결과를 답변에 활용하는 방식",
    pageNumber: 1,
    occurrences: 1,
    source: "demo"
  }],
  phraseSet: ["RAG", "래그"],
  mode: "demo"
};

describe("runAnalysisEntryWorkflow", () => {
  it.each(["pdf", "demo"] as const)("runs the same extract/analyze/store contract for %s", async (kind) => {
    const controller = new AbortController();
    const events: string[] = [];
    const store = vi.fn(async (result: AnalysisResult, fallbackName: string) => {
      events.push(`store:${fallbackName}`);
      return { readyValue: result, completed: true };
    });

    await expect(runAnalysisEntryWorkflow({
      source: {
        kind,
        fileName: kind === "pdf" ? "slides.pdf" : "sample.pdf",
        sourceFile: null,
        fallbackGlossaryName: kind === "pdf" ? "강연 용어집" : "샘플 강연 용어집",
        extract: async () => {
          events.push("extract");
          return analysis;
        },
        analyze: async (result) => {
          events.push("analyze");
          return result;
        }
      },
      store,
      onStateChange: () => undefined,
      signal: controller.signal
    })).resolves.toEqual(analysis);

    expect(events).toEqual([
      "extract",
      "analyze",
      `store:${kind === "pdf" ? "강연 용어집" : "샘플 강연 용어집"}`
    ]);
  });
});

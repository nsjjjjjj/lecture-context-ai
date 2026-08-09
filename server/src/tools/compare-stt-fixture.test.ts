import { describe, expect, it } from "vitest";
import { buildFixtureTerms, findRecognizedTerms } from "./compare-stt-fixture.js";

describe("fixed audio STT comparison helpers", () => {
  it("builds stable glossary terms for the WebSocket matcher", () => {
    expect(buildFixtureTerms(["RAG", "PhraseSet"])).toMatchObject([
      { id: "fixture-term-01", term: "RAG", english: "RAG", source: "demo" },
      { id: "fixture-term-02", term: "PhraseSet", english: "PhraseSet", source: "demo" }
    ]);
  });

  it("counts only terms explicitly matched by the server", () => {
    const terms = buildFixtureTerms(["RAG", "PhraseSet"]);
    expect(findRecognizedTerms(["RAG", "PhraseSet"], terms, [
      {
        text: "RAG와 PhraseSet을 설명합니다.",
        rawText: "레그와 PhraseSet을 설명합니다.",
        detectedTermIds: ["fixture-term-01", "fixture-term-02"],
        corrections: [{
          originalText: "레그",
          correctedText: "RAG",
          termId: "fixture-term-01",
          displayStart: 0,
          displayEnd: 3,
          reason: "spokenAlias"
        }]
      }
    ])).toEqual(["PhraseSet"]);
  });
});

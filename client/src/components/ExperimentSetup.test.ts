import { describe, expect, it } from "vitest";
import { parseManualTargetTerms } from "./ExperimentSetup";

describe("experiment setup manual gold targets", () => {
  it("parses one target per line without turning it into a PDF adaptation term", () => {
    expect(parseManualTargetTerms("LoRA | Low-Rank Adaptation |\nRAG | Retrieval-Augmented Generation | 래그, 레그")).toEqual([
      { canonicalTerm: "LoRA", english: "Low-Rank Adaptation", spokenAliases: [] },
      { canonicalTerm: "RAG", english: "Retrieval-Augmented Generation", spokenAliases: ["래그", "레그"] }
    ]);
  });
});

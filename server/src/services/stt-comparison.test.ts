import { describe, expect, it } from "vitest";
import {
  buildComparisonRunDefinitions,
  comparisonReportFileSchema,
  fixtureScriptSchema,
  isLegacyComparisonReport,
  scoreComparisonRun,
  type ComparisonFinalTranscript,
  type FixtureScript
} from "./stt-comparison.js";

function comparisonScript(): FixtureScript {
  return fixtureScriptSchema.parse({
    id: "comparison-v2",
    title: "반복 occurrence 비교",
    languageCode: "ko-KR",
    text: "RAG와 PhraseSet, 그리고 래그를 비교합니다.",
    targetTerms: [
      {
        id: "rag",
        canonicalTerm: "RAG",
        english: "Retrieval-Augmented Generation",
        spokenAliases: ["래그", "레그"],
        expectedOccurrences: [1, 3]
      },
      {
        id: "phrase-set",
        canonicalTerm: "PhraseSet",
        spokenAliases: ["프레이즈셋"],
        expectedOccurrences: [2]
      }
    ]
  });
}

describe("fixed STT A/B/C definitions", () => {
  it("builds each required condition exactly once with the correct PhraseSet and aliases", () => {
    const definitions = buildComparisonRunDefinitions(comparisonScript());

    expect(definitions.map((definition) => definition.label)).toEqual([
      "without-phrase-set",
      "canonical-phrase-set",
      "spoken-alias-phrase-set"
    ]);
    expect(definitions[0]?.phraseSet).toEqual([]);
    expect(definitions[1]?.phraseSet).toEqual(["RAG", "Retrieval-Augmented Generation", "PhraseSet"]);
    expect(definitions[2]?.phraseSet).toEqual([
      "RAG",
      "Retrieval-Augmented Generation",
      "래그",
      "레그",
      "PhraseSet",
      "프레이즈셋"
    ]);
    expect(definitions[0]?.terms.flatMap((term) => term.spokenAliases)).toEqual([]);
    expect(definitions[1]?.terms.flatMap((term) => term.spokenAliases)).toEqual([]);
    expect(definitions[2]?.terms.map((term) => term.spokenAliases)).toEqual([
      ["래그", "레그"],
      ["프레이즈셋"]
    ]);
  });

  it("rejects plausible but unreviewed Korean aliases in fixture data", () => {
    const value = comparisonScript();
    value.targetTerms[0]!.spokenAliases.push("사과");

    expect(() => fixtureScriptSchema.parse(value)).toThrow("검토 완료 별칭");
  });

  it("rejects an alias that collides with a later canonical term regardless of declaration order", () => {
    expect(() => fixtureScriptSchema.parse({
      id: "reverse-collision-v2",
      title: "역순 충돌",
      languageCode: "ko-KR",
      text: "래그와 RAG를 비교합니다.",
      targetTerms: [
        { id: "rag", canonicalTerm: "RAG", spokenAliases: ["래그"], expectedOccurrences: [1] },
        { id: "rag-pronunciation", canonicalTerm: "래그", spokenAliases: [], expectedOccurrences: [2] }
      ]
    })).toThrow("충돌");
  });
});

describe("occurrence-level comparison scoring", () => {
  const repeatedTranscript: ComparisonFinalTranscript = {
    text: "RAG와 PhraseSet, 그리고 RAG를 비교합니다.",
    rawText: "RAG와 PhraseSet, 그리고 래그를 비교합니다.",
    detectedTermIds: ["rag", "phrase-set", "rag"],
    corrections: [{
      originalText: "래그",
      correctedText: "RAG",
      termId: "rag",
      displayStart: 20,
      displayEnd: 23,
      reason: "spokenAlias"
    }]
  };

  it("aligns repeated expected occurrences to direct matches and reviewed alias corrections", () => {
    const result = scoreComparisonRun({
      runLabel: "spoken-alias-phrase-set",
      script: comparisonScript(),
      finalTranscripts: [repeatedTranscript],
      speakerReadReferenceScriptVerbatim: true
    });

    expect(result.metrics).toEqual({
      evaluationMode: "accuracy",
      accuracyValid: true,
      directRecognitions: 2,
      aliasCorrectionSuccesses: 1,
      misses: 0,
      falseCorrections: 0,
      falseInsertions: 0,
      expectedOccurrenceCount: 3,
      productLinkRate: 1
    });
    expect(result.occurrenceResults.map((occurrence) => [occurrence.sequence, occurrence.targetTermId, occurrence.outcome])).toEqual([
      [1, "rag", "direct-recognition"],
      [2, "phrase-set", "direct-recognition"],
      [3, "rag", "alias-correction"]
    ]);
  });

  it("never credits alias corrections in A/B and records them as false corrections", () => {
    for (const runLabel of ["without-phrase-set", "canonical-phrase-set"] as const) {
      const result = scoreComparisonRun({
        runLabel,
        script: comparisonScript(),
        finalTranscripts: [repeatedTranscript],
        speakerReadReferenceScriptVerbatim: true
      });

      expect(result.metrics).toMatchObject({
        directRecognitions: 2,
        aliasCorrectionSuccesses: 0,
        misses: 1,
        falseCorrections: 1,
        falseInsertions: 0,
        expectedOccurrenceCount: 3,
        productLinkRate: 2 / 3
      });
      expect(result.unexpectedObservations).toContainEqual(expect.objectContaining({
        kind: "false-correction",
        reason: "unexpected-alias-correction",
        targetTermId: "rag"
      }));
    }
  });

  it("keeps identical observed metrics explicitly smoke-only for an unverified recording", () => {
    const result = scoreComparisonRun({
      runLabel: "spoken-alias-phrase-set",
      script: comparisonScript(),
      finalTranscripts: [repeatedTranscript],
      speakerReadReferenceScriptVerbatim: false
    });

    expect(result.metrics).toMatchObject({ evaluationMode: "smoke", accuracyValid: false, productLinkRate: 1 });
  });

  it("counts extra direct terms, unexpected valid corrections, and invalid corrections", () => {
    const script = fixtureScriptSchema.parse({
      id: "false-events-v2",
      title: "false event 비교",
      languageCode: "ko-KR",
      text: "RAG",
      targetTerms: [{
        id: "rag",
        canonicalTerm: "RAG",
        spokenAliases: ["래그"],
        expectedOccurrences: [1]
      }]
    });
    const result = scoreComparisonRun({
      runLabel: "spoken-alias-phrase-set",
      script,
      speakerReadReferenceScriptVerbatim: true,
      finalTranscripts: [{
        text: "RAG RAG RAG 사과",
        rawText: "RAG RAG 래그를 사과라고 했습니다.",
        detectedTermIds: ["rag", "rag", "rag"],
        corrections: [
          { originalText: "래그", correctedText: "RAG", termId: "rag", displayStart: 8, displayEnd: 11, reason: "spokenAlias" },
          { originalText: "사과", correctedText: "RAG", termId: "rag", displayStart: 12, displayEnd: 15, reason: "spokenAlias" }
        ]
      }]
    });

    expect(result.metrics).toMatchObject({
      directRecognitions: 1,
      aliasCorrectionSuccesses: 0,
      misses: 0,
      falseCorrections: 2,
      falseInsertions: 1,
      expectedOccurrenceCount: 1,
      productLinkRate: 1
    });
    expect(result.unexpectedObservations.map((observation) => observation.reason).sort()).toEqual([
      "invalid-correction",
      "unexpected-alias-correction",
      "unexpected-direct-match"
    ]);
  });

  it("counts missing expected occurrences instead of collapsing repeated terms", () => {
    const result = scoreComparisonRun({
      runLabel: "without-phrase-set",
      script: comparisonScript(),
      finalTranscripts: [{ text: "RAG", rawText: "RAG", detectedTermIds: ["rag"], corrections: [] }],
      speakerReadReferenceScriptVerbatim: true
    });

    expect(result.metrics).toMatchObject({ directRecognitions: 1, misses: 2, expectedOccurrenceCount: 3, productLinkRate: 1 / 3 });
  });
});

describe("comparison report compatibility boundary", () => {
  it("classifies v1/v2 files as legacy instead of implying v3 accuracy semantics", () => {
    for (const version of [1, 2] as const) {
      const report = comparisonReportFileSchema.parse({ version, runs: [] });
      expect(isLegacyComparisonReport(report)).toBe(true);
    }
  });
});

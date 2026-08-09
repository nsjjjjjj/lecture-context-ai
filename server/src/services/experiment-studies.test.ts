import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildComparisonRunDefinitions, scoreComparisonRun } from "./stt-comparison.js";
import { buildExperimentTargetTerms, ExperimentStudyStoreService } from "./experiment-studies.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "lecture-studies-"));
  roots.push(root);
  return root;
}

const glossary = {
  id: "glossary-browser-1",
  name: "AI 발표 PDF",
  updatedAt: "2026-08-09T00:00:00.000Z",
  terms: [
    {
      id: "term-rag",
      term: "RAG",
      english: "Retrieval-Augmented Generation",
      spokenAliases: ["래그"],
      easyExplanation: "검색으로 답변을 보강하는 방식",
      pageNumber: 1,
      occurrences: 2,
      source: "gemini" as const
    },
    {
      id: "term-llm",
      term: "LLM",
      english: "Large Language Model",
      spokenAliases: ["엘엘엠"],
      easyExplanation: "대규모 언어 모델",
      pageNumber: 2,
      occurrences: 1,
      source: "gemini" as const
    },
    {
      id: "term-bert",
      term: "BERT",
      english: "",
      spokenAliases: ["버트"],
      easyExplanation: "문맥을 양방향으로 이해하는 언어 모델",
      pageNumber: 2,
      occurrences: 1,
      source: "gemini" as const
    }
  ]
};

describe("experiment study snapshots", () => {
  it("assigns the same script occurrence to overlapping scoring terms", () => {
    const targets = buildExperimentTargetTerms("Listen, Attend and Spell을 설명합니다.", [
      { canonicalTerm: "LAS", english: "Listen, Attend and Spell", spokenAliases: [] },
      { canonicalTerm: "Listen, Attend and Spell", english: "", spokenAliases: [] }
    ]);

    expect(targets.map((term) => [term.canonicalTerm, term.expectedOccurrences])).toEqual([
      ["LAS", [1]],
      ["Listen, Attend and Spell", [1]]
    ]);
  });

  it("keeps PDF adaptation terms separate from script gold targets and persists immutable hashes", async () => {
    const root = await temporaryRoot();
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222"
    ];
    const service = new ExperimentStudyStoreService(
      root,
      () => new Date("2026-08-09T00:00:00.000Z"),
      () => ids.shift()!
    );
    const study = await service.createStudy({ title: "PDF STT 연구 v1" });
    const experimentCase = await service.createCase(study.id, {
      title: "AI 발표 케이스",
      scriptText: "래그와 LoRA를 비교하고 래그를 다시 설명합니다.",
      glossary,
      targetTerms: [
        { canonicalTerm: "RAG", english: "Retrieval-Augmented Generation", spokenAliases: ["래그"] },
        { canonicalTerm: "LoRA", english: "", spokenAliases: [] }
      ]
    });

    expect(experimentCase.script.targetTerms.map((term) => [term.canonicalTerm, term.expectedOccurrences])).toEqual([
      ["RAG", [1, 3]],
      ["LoRA", [2]]
    ]);
    expect(experimentCase.script.adaptationTerms?.map((term) => term.canonicalTerm)).toEqual(["RAG", "LLM", "BERT"]);
    expect(experimentCase.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(experimentCase.script.experimentIdentity).toMatchObject({
      studyId: study.id,
      caseId: experimentCase.id,
      caseSnapshotId: experimentCase.snapshotId,
      glossaryName: glossary.name
    });

    const definitions = buildComparisonRunDefinitions(experimentCase.script);
    expect(definitions[0]?.phraseSet).toEqual([]);
    expect(definitions[1]?.phraseSet).toContain("RAG");
    expect(definitions[1]?.phraseSet).toContain("LLM");
    expect(definitions[1]?.phraseSet).not.toContain("LoRA");
    expect(definitions[2]?.phraseSet).toContain("래그");
    expect(definitions[2]?.phraseSet).toContain("버트");

    const cScore = scoreComparisonRun({
      runLabel: "spoken-alias-phrase-set",
      script: experimentCase.script,
      speakerReadReferenceScriptVerbatim: true,
      finalTranscripts: [{
        text: "RAG(래그)와 LoRA를 비교하고 RAG(래그)를 다시 설명합니다.",
        rawText: "래그와 LoRA를 비교하고 래그를 다시 설명합니다.",
        detectedTermIds: ["pdf-01"],
        corrections: [
          { originalText: "래그", correctedText: "RAG", termId: "pdf-01", displayStart: 0, displayEnd: 3, reason: "spokenAlias" },
          { originalText: "래그", correctedText: "RAG", termId: "pdf-01", displayStart: 22, displayEnd: 25, reason: "spokenAlias" }
        ]
      }]
    });
    expect(cScore.metrics).toMatchObject({ directRecognitions: 1, aliasCorrectionSuccesses: 2, misses: 0 });

    const reloaded = await new ExperimentStudyStoreService(root).getCatalog();
    expect(reloaded.studies[0]?.cases[0]).toEqual(experimentCase);
  });

  it("rejects a duplicate snapshot instead of silently overwriting it", async () => {
    const root = await temporaryRoot();
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333"
    ];
    const service = new ExperimentStudyStoreService(root, () => new Date("2026-08-09T00:00:00.000Z"), () => ids.shift()!);
    const study = await service.createStudy({ title: "중복 방지" });
    const input = {
      title: "같은 케이스",
      scriptText: "래그를 설명합니다.",
      glossary,
      targetTerms: [{ canonicalTerm: "RAG", english: "Retrieval-Augmented Generation", spokenAliases: ["래그"] }]
    };
    await service.createCase(study.id, input);
    await expect(service.createCase(study.id, input)).rejects.toMatchObject({ status: 409 });
    expect((await service.getCatalog()).studies[0]?.cases).toHaveLength(1);
  });

  it("원본 50개에 영문·한글 발음이 모두 있어도 케이스와 A/B/C 조건을 만든다", async () => {
    const root = await temporaryRoot();
    const service = new ExperimentStudyStoreService(
      root,
      () => new Date("2026-08-09T00:00:00.000Z"),
      (() => {
        const ids = [
          "11111111-1111-4111-8111-111111111111",
          "22222222-2222-4222-8222-222222222222"
        ];
        return () => ids.shift()!;
      })()
    );
    const study = await service.createStudy({ title: "50개 원본 용어 연구" });
    const terms = Array.from({ length: 50 }, (_, index) => ({
      id: `term-${index}`,
      term: `Term ${index}`,
      english: `English ${index}`,
      spokenAliases: [`${String.fromCharCode(0xac00 + index)}음`],
      easyExplanation: `용어 ${index} 설명`,
      pageNumber: 1,
      occurrences: 1,
      source: "gemini" as const
    }));

    const experimentCase = await service.createCase(study.id, {
      title: "50개 용어 케이스",
      scriptText: `${terms[0]!.spokenAliases[0]}을 설명합니다.`,
      glossary: { ...glossary, id: "glossary-50", name: "50개 용어 PDF", terms },
      targetTerms: [{
        canonicalTerm: terms[0]!.term,
        english: terms[0]!.english,
        spokenAliases: terms[0]!.spokenAliases
      }]
    });
    const definitions = buildComparisonRunDefinitions(experimentCase.script);

    expect(experimentCase.script.adaptationTerms).toHaveLength(50);
    expect(definitions[1]?.phraseSet).toHaveLength(100);
    expect(definitions[2]?.phraseSet).toHaveLength(150);
    expect(definitions[2]?.phraseSet).toContain(terms[49]!.spokenAliases[0]);
  });
});

import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildComparisonRunDefinitions,
  comparisonRunResultSchema,
  fixtureScriptSchema,
  scoreComparisonRun
} from "../services/stt-comparison.js";
import { createComparisonReport, writeComparisonReportAtomically } from "./compare-stt-fixture.js";

describe("fixed audio STT v3 report writer", () => {
  it("produces and atomically replaces a 0600 v3 report with all three smoke-only runs", async () => {
    const script = fixtureScriptSchema.parse({
      id: "writer-v2",
      title: "writer fixture",
      languageCode: "ko-KR",
      text: "RAG",
      targetTerms: [{
        id: "rag",
        canonicalTerm: "RAG",
        english: "Retrieval-Augmented Generation",
        spokenAliases: ["래그"],
        expectedOccurrences: [1]
      }]
    });
    const runs = buildComparisonRunDefinitions(script).map((definition) => comparisonRunResultSchema.parse({
      ...definition,
      status: "completed",
      startedAt: "2026-08-09T00:00:00.000Z",
      readyAfterMs: 10,
      audioDurationMs: 1_000,
      wallClockMs: 1_100,
      interimCount: 0,
      finalTranscripts: [],
      transcript: "",
      rawTranscript: "",
      ...scoreComparisonRun({
        runLabel: definition.label,
        script,
        finalTranscripts: [],
        speakerReadReferenceScriptVerbatim: false
      }),
      errors: []
    }));

    const report = createComparisonReport({
      createdAt: "2026-08-09T00:01:00.000Z",
      recording: {
        id: "123e4567-e89b-42d3-a456-426614174000",
        scriptId: script.id,
        speakerReadReferenceScriptVerbatim: false
      },
      script,
      websocketUrl: "ws://127.0.0.1:8787/ws",
      runs
    });

    expect(report.version).toBe(3);
    expect(report.recording).toMatchObject({ evaluationMode: "smoke", speakerReadReferenceScriptVerbatim: false });
    expect(report.runs.map((run) => run.label)).toEqual([
      "without-phrase-set",
      "canonical-phrase-set",
      "spoken-alias-phrase-set"
    ]);
    expect(report.runs.every((run) => run.metrics.accuracyValid === false)).toBe(true);

    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "stt-comparison-report-"));
    const outputPath = path.join(temporaryRoot, "comparison.json");
    try {
      await writeFile(outputPath, "legacy contents", { mode: 0o644 });
      await writeComparisonReportAtomically(outputPath, report);

      expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(report);
      expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
      expect(await readdir(temporaryRoot)).toEqual(["comparison.json"]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

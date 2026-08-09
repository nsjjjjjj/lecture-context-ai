import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildComparisonRunDefinitions,
  comparisonReportV3Schema,
  fixtureScriptSchema,
  isLegacyComparisonReport
} from "./stt-comparison.js";
import {
  MAX_COMPARISON_REPORT_BYTES,
  readSttComparisonResults
} from "./stt-comparison-results.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(prefix = "stt-comparison-results-"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function fixtureRootWithResults(): Promise<{ root: string; results: string }> {
  const root = await temporaryRoot();
  const results = path.join(root, "results");
  await mkdir(results);
  return { root, results };
}

function validV3Report(transcript: string) {
  const script = fixtureScriptSchema.parse({
    id: "baseline-v3",
    title: "v3 comparison",
    languageCode: "ko-KR",
    text: "RAG",
    targetTerms: [{
      id: "rag",
      canonicalTerm: "RAG",
      english: "",
      spokenAliases: [],
      expectedOccurrences: [1]
    }]
  });
  const runs = buildComparisonRunDefinitions(script).map((definition) => ({
    ...definition,
    status: "completed" as const,
    startedAt: "2026-08-09T00:00:00.000Z",
    readyAfterMs: 0,
    audioDurationMs: 1_000,
    wallClockMs: 1_000,
    interimCount: 0,
    finalTranscripts: [{ text: transcript, rawText: transcript, detectedTermIds: ["rag"], corrections: [] }],
    transcript,
    rawTranscript: transcript,
    metrics: {
      evaluationMode: "accuracy" as const,
      accuracyValid: true,
      directRecognitions: 1,
      aliasCorrectionSuccesses: 0,
      misses: 0,
      falseCorrections: 0,
      falseInsertions: 0,
      expectedOccurrenceCount: 1,
      productLinkRate: 1
    },
    occurrenceResults: [{
      sequence: 1,
      targetTermId: "rag",
      canonicalTerm: "RAG",
      outcome: "direct-recognition" as const,
      finalTranscriptIndex: 0,
      rawText: transcript
    }],
    unexpectedObservations: [],
    errors: []
  }));

  return comparisonReportV3Schema.parse({
    version: 3,
    createdAt: "2026-08-09T00:01:00.000Z",
    recording: {
      id: "11111111-1111-4111-8111-111111111111",
      scriptId: script.id,
      speakerReadReferenceScriptVerbatim: true,
      evaluationMode: "accuracy"
    },
    script,
    websocketUrl: "ws://127.0.0.1:8787/ws",
    measurementNote: "Verified reference-script comparison.",
    runs
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("STT comparison result discovery", () => {
  it("returns the stable empty response when the results directory has no reports", async () => {
    const { root } = await fixtureRootWithResults();

    await expect(readSttComparisonResults(root)).resolves.toEqual({ latest: null, reportCount: 0 });
  });

  it("returns the newest valid v3 report with complete final transcripts", async () => {
    const { root, results } = await fixtureRootWithResults();
    const legacyPath = path.join(results, "comparison-older.json");
    const v3Path = path.join(results, "comparison-newer.json");
    const v3 = validV3Report("full v3 transcript");
    await writeFile(legacyPath, JSON.stringify({ version: 2, runs: [{ transcript: "legacy transcript" }] }));
    await writeFile(v3Path, JSON.stringify(v3));
    await utimes(legacyPath, new Date("2026-08-09T00:00:00.000Z"), new Date("2026-08-09T00:00:00.000Z"));
    await utimes(v3Path, new Date("2026-08-09T00:02:00.000Z"), new Date("2026-08-09T00:02:00.000Z"));

    const result = await readSttComparisonResults(root);

    expect(result.reportCount).toBe(2);
    expect(result.latest).toEqual(v3);
    expect(result.latest).toMatchObject({
      runs: expect.arrayContaining([
        expect.objectContaining({
          finalTranscripts: [expect.objectContaining({ text: "full v3 transcript", rawText: "full v3 transcript" })]
        })
      ])
    });
  });

  it("returns v1/v2 only as opaque legacy data without adding accuracy semantics", async () => {
    const { root, results } = await fixtureRootWithResults();
    const legacy = { version: 2, createdAt: "legacy timestamp", runs: [{ transcript: "legacy transcript" }] };
    await writeFile(path.join(results, "comparison-legacy.json"), JSON.stringify(legacy));

    const result = await readSttComparisonResults(root);

    expect(result).toEqual({ reportCount: 1, latest: legacy });
    expect(result.latest && isLegacyComparisonReport(result.latest)).toBe(true);
    expect(result.latest).not.toHaveProperty("metrics");
    expect(result.latest).not.toHaveProperty("accuracyValid");
  });

  it("silently skips malformed, schema-invalid, oversized, symlinked, non-regular, and nonmatching entries", async () => {
    const { root, results } = await fixtureRootWithResults();
    const outsideRoot = await temporaryRoot("stt-comparison-outside-");
    const outsidePath = path.join(outsideRoot, "outside.json");
    await writeFile(outsidePath, JSON.stringify({ version: 2, secret: "must not escape" }));

    await writeFile(path.join(results, "comparison-valid.json"), JSON.stringify({ version: 1, runs: [{ transcript: "safe" }] }));
    await writeFile(path.join(results, "comparison-malformed.json"), "{not json");
    await writeFile(path.join(results, "comparison-invalid-schema.json"), JSON.stringify({ version: 3 }));
    await writeFile(path.join(results, "comparison-oversized.json"), Buffer.alloc(MAX_COMPARISON_REPORT_BYTES + 1, 0x20));
    await writeFile(path.join(results, "not-a-comparison.json"), JSON.stringify(validV3Report("nonmatching")));
    await mkdir(path.join(results, "comparison-directory.json"));
    await symlink(outsidePath, path.join(results, "comparison-symlink.json"));

    const result = await readSttComparisonResults(root);

    expect(result).toMatchObject({
      reportCount: 1,
      latest: { version: 1, runs: [{ transcript: "safe" }] }
    });
    expect(JSON.stringify(result)).not.toContain("must not escape");
    expect(JSON.stringify(result)).not.toContain("nonmatching");
  });

  it("does not follow a symlinked results directory outside the fixture root", async () => {
    const root = await temporaryRoot();
    const outsideRoot = await temporaryRoot("stt-comparison-results-outside-");
    await writeFile(path.join(outsideRoot, "comparison-outside.json"), JSON.stringify({ version: 2, secret: true }));
    await symlink(outsideRoot, path.join(root, "results"));

    await expect(readSttComparisonResults(root)).resolves.toEqual({ latest: null, reportCount: 0 });
  });
});

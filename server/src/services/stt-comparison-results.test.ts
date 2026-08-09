import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildComparisonRunDefinitions,
  comparisonReportV3Schema,
  comparisonReportV4Schema,
  fixtureScriptSchema,
  isLegacyComparisonReport
} from "./stt-comparison.js";
import {
  DEFAULT_STT_COMPARISON_RESULTS_LIMIT,
  MAX_COMPARISON_REPORT_BYTES,
  MAX_STT_COMPARISON_RESULTS_LIMIT,
  isValidSttComparisonResultFileName,
  readSttComparisonCaseAggregates,
  readSttComparisonResult,
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

function validV4Report() {
  const identity = {
    studyId: "study-11111111-1111-4111-8111-111111111111",
    caseId: "case-22222222-2222-4222-8222-222222222222",
    caseSnapshotId: "snapshot-1234567890abcdef12345678",
    glossaryId: "browser-glossary-1",
    glossaryName: "AI PDF",
    glossaryHash: "a".repeat(64),
    scriptHash: "b".repeat(64)
  };
  const script = fixtureScriptSchema.parse({
    id: identity.caseId,
    title: "PDF case",
    languageCode: "ko-KR",
    text: "래그",
    targetTerms: [{ id: "rag", canonicalTerm: "RAG", english: "", spokenAliases: ["래그"], expectedOccurrences: [1] }],
    adaptationTerms: [{ id: "pdf-01", canonicalTerm: "RAG", english: "", spokenAliases: ["래그"] }],
    experimentIdentity: identity
  });
  const rates = [0, 1, 1];
  const runs = buildComparisonRunDefinitions(script).map((definition, index) => ({
    ...definition,
    status: "completed" as const,
    startedAt: "2026-08-09T00:00:00.000Z",
    readyAfterMs: 0,
    audioDurationMs: 1_000,
    wallClockMs: 1_000,
    interimCount: 0,
    finalTranscripts: [],
    transcript: "",
    rawTranscript: "",
    metrics: {
      evaluationMode: "accuracy" as const,
      accuracyValid: true,
      directRecognitions: rates[index]!,
      aliasCorrectionSuccesses: 0,
      misses: 1 - rates[index]!,
      falseCorrections: 0,
      falseInsertions: 0,
      expectedOccurrenceCount: 1,
      productLinkRate: rates[index]!
    },
    occurrenceResults: [{
      sequence: 1,
      targetTermId: "rag",
      canonicalTerm: "RAG",
      outcome: rates[index] ? "direct-recognition" as const : "miss" as const,
      finalTranscriptIndex: null,
      rawText: null
    }],
    unexpectedObservations: [],
    errors: []
  }));
  return comparisonReportV4Schema.parse({
    version: 4,
    createdAt: "2026-08-09T00:01:00.000Z",
    recording: {
      id: "11111111-1111-4111-8111-111111111111",
      scriptId: script.id,
      speakerReadReferenceScriptVerbatim: true,
      evaluationMode: "accuracy",
      experimentIdentity: identity
    },
    script,
    websocketUrl: "ws://127.0.0.1:8787/ws",
    measurementNote: "PDF experiment",
    runs
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("STT comparison result discovery", () => {
  it("filters v4 case history and aggregates complete accuracy reports without mixing legacy data", async () => {
    const { root, results } = await fixtureRootWithResults();
    const report = validV4Report();
    await writeFile(path.join(results, "comparison-study.json"), JSON.stringify(report));
    await writeFile(path.join(results, "comparison-legacy.json"), JSON.stringify({ version: 2 }));

    const filtered = await readSttComparisonResults(root, {
      studyId: report.recording.experimentIdentity!.studyId,
      caseId: report.recording.experimentIdentity!.caseId
    });
    const aggregate = await readSttComparisonCaseAggregates(root, {
      studyId: report.recording.experimentIdentity!.studyId
    });

    expect(filtered.reportCount).toBe(1);
    expect(filtered.history[0]).toMatchObject({
      version: 4,
      caseId: report.recording.experimentIdentity!.caseId,
      glossaryName: "AI PDF"
    });
    expect(aggregate.cases).toEqual([expect.objectContaining({
      caseTitle: "PDF case",
      reportCount: 1,
      accuracyReportCount: 1,
      rates: {
        "without-phrase-set": 0,
        "canonical-phrase-set": 1,
        "spoken-alias-phrase-set": 1
      }
    })]);
  });

  it("returns the stable empty response with default pagination", async () => {
    const { root } = await fixtureRootWithResults();

    await expect(readSttComparisonResults(root)).resolves.toEqual({
      latest: null,
      latestFileName: null,
      reportCount: 0,
      history: [],
      page: { offset: 0, limit: DEFAULT_STT_COMPARISON_RESULTS_LIMIT, hasMore: false }
    });
  });

  it("paginates summaries in mtime-descending and filename-descending order without changing latest", async () => {
    const { root, results } = await fixtureRootWithResults();
    const reports = [
      ["comparison-oldest.json", "oldest", "2026-08-09T00:00:00.000Z"],
      ["comparison-alpha.json", "alpha", "2026-08-09T00:01:00.000Z"],
      ["comparison-zulu.json", "zulu", "2026-08-09T00:01:00.000Z"],
      ["comparison-newest.json", "newest", "2026-08-09T00:02:00.000Z"]
    ] as const;
    for (const [fileName, marker, modifiedAt] of reports) {
      const filePath = path.join(results, fileName);
      await writeFile(filePath, JSON.stringify({ version: 2, marker }));
      await utimes(filePath, new Date(modifiedAt), new Date(modifiedAt));
    }

    const result = await readSttComparisonResults(root, { offset: 1, limit: 2 });

    expect(result.latestFileName).toBe("comparison-newest.json");
    expect(result.latest).toEqual({ version: 2, marker: "newest" });
    expect(result.reportCount).toBe(4);
    expect(result.history.map(({ fileName }) => fileName)).toEqual([
      "comparison-zulu.json",
      "comparison-alpha.json"
    ]);
    expect(result.page).toEqual({ offset: 1, limit: 2, hasMore: true });
  });

  it("uses the default page size and caps requested limits at 100", async () => {
    const { root, results } = await fixtureRootWithResults();
    await writeFile(path.join(results, "comparison-only.json"), JSON.stringify({ version: 1 }));

    const defaultPage = await readSttComparisonResults(root);
    const cappedPage = await readSttComparisonResults(root, { limit: MAX_STT_COMPARISON_RESULTS_LIMIT + 50 });

    expect(defaultPage.page.limit).toBe(DEFAULT_STT_COMPARISON_RESULTS_LIMIT);
    expect(cappedPage.page).toEqual({ offset: 0, limit: MAX_STT_COMPARISON_RESULTS_LIMIT, hasMore: false });
  });

  it("keeps the newest valid v3 report complete and exposes only validated summary metadata", async () => {
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
    expect(result.latestFileName).toBe("comparison-newer.json");
    expect(result.latest).toEqual(v3);
    expect(result.latest).toMatchObject({
      runs: expect.arrayContaining([
        expect.objectContaining({
          finalTranscripts: [expect.objectContaining({ text: "full v3 transcript", rawText: "full v3 transcript" })]
        })
      ])
    });
    expect(result.history[0]).toEqual({
      fileName: "comparison-newer.json",
      modifiedAt: "2026-08-09T00:02:00.000Z",
      version: 3,
      createdAt: "2026-08-09T00:01:00.000Z",
      recordingId: "11111111-1111-4111-8111-111111111111",
      scriptTitle: "v3 comparison",
      evaluationMode: "accuracy",
      runOutcome: "complete"
    });
  });

  it("marks a v3 report with a failed run as has-errors", async () => {
    const { root, results } = await fixtureRootWithResults();
    const report = validV3Report("partial transcript");
    report.runs[1]!.status = "error";
    report.runs[1]!.errors = ["stream failed"];
    await writeFile(path.join(results, "comparison-error.json"), JSON.stringify(report));

    const result = await readSttComparisonResults(root);

    expect(result.history[0]?.runOutcome).toBe("has-errors");
  });

  it("returns v1/v2 as opaque legacy reports and never infers summary accuracy or metrics", async () => {
    const { root, results } = await fixtureRootWithResults();
    const legacy = {
      version: 2,
      createdAt: "2026-08-09T00:01:00.000Z",
      recording: { id: "untrusted-recording", evaluationMode: "accuracy" },
      script: { title: "untrusted title" },
      metrics: { accuracy: 99 },
      runs: [{ transcript: "legacy transcript" }]
    };
    await writeFile(path.join(results, "comparison-legacy.json"), JSON.stringify(legacy));

    const result = await readSttComparisonResults(root);

    expect(result.reportCount).toBe(1);
    expect(result.latestFileName).toBe("comparison-legacy.json");
    expect(result.latest).toEqual(legacy);
    expect(result.latest && isLegacyComparisonReport(result.latest)).toBe(true);
    expect(result.history[0]).toMatchObject({
      version: 2,
      createdAt: null,
      recordingId: null,
      scriptTitle: null,
      evaluationMode: null,
      runOutcome: "legacy"
    });
    expect(result.history[0]).not.toHaveProperty("metrics");
    expect(result.history[0]).not.toHaveProperty("accuracyValid");
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

    expect(result.reportCount).toBe(1);
    expect(result.latestFileName).toBe("comparison-valid.json");
    expect(result.latest).toEqual({ version: 1, runs: [{ transcript: "safe" }] });
    expect(result.history.map(({ fileName }) => fileName)).toEqual(["comparison-valid.json"]);
    expect(JSON.stringify(result)).not.toContain("must not escape");
    expect(JSON.stringify(result)).not.toContain("nonmatching");
  });

  it("does not follow a symlinked results directory outside the fixture root", async () => {
    const root = await temporaryRoot();
    const outsideRoot = await temporaryRoot("stt-comparison-results-outside-");
    await writeFile(path.join(outsideRoot, "comparison-outside.json"), JSON.stringify({ version: 2, secret: true }));
    await symlink(outsideRoot, path.join(root, "results"));

    await expect(readSttComparisonResults(root)).resolves.toEqual({
      latest: null,
      latestFileName: null,
      reportCount: 0,
      history: [],
      page: { offset: 0, limit: DEFAULT_STT_COMPARISON_RESULTS_LIMIT, hasMore: false }
    });
  });
});

describe("individual STT comparison result reads", () => {
  it("returns the exact validated report with filename and filesystem modification time", async () => {
    const { root, results } = await fixtureRootWithResults();
    const fileName = "comparison-detail.json";
    const filePath = path.join(results, fileName);
    const report = validV3Report("detail transcript");
    await writeFile(filePath, JSON.stringify(report));
    await utimes(filePath, new Date("2026-08-09T02:03:04.000Z"), new Date("2026-08-09T02:03:04.000Z"));

    await expect(readSttComparisonResult(root, fileName)).resolves.toEqual({
      fileName,
      modifiedAt: "2026-08-09T02:03:04.000Z",
      report
    });
    await expect(readSttComparisonResult(root, "comparison-missing.json")).resolves.toBeNull();
  });

  it("exports exact filename validation and rejects path escape attempts", async () => {
    const { root } = await fixtureRootWithResults();

    expect(isValidSttComparisonResultFileName("comparison-safe_01.json")).toBe(true);
    expect(isValidSttComparisonResultFileName("../comparison-safe.json")).toBe(false);
    expect(isValidSttComparisonResultFileName("comparison/nested.json")).toBe(false);
    expect(isValidSttComparisonResultFileName("comparison-safe.json/extra")).toBe(false);
    expect(isValidSttComparisonResultFileName(`comparison-${"a".repeat(129)}.json`)).toBe(false);
    await expect(readSttComparisonResult(root, "../comparison-safe.json")).resolves.toBeNull();
  });

  it("returns null for malformed, schema-invalid, oversized, symlinked, and nonmatching detail targets", async () => {
    const { root, results } = await fixtureRootWithResults();
    const outsideRoot = await temporaryRoot("stt-comparison-detail-outside-");
    const outsidePath = path.join(outsideRoot, "comparison-outside.json");
    await writeFile(outsidePath, JSON.stringify({ version: 2, secret: "must not escape" }));

    await writeFile(path.join(results, "comparison-malformed.json"), "{not json");
    await writeFile(path.join(results, "comparison-invalid-schema.json"), JSON.stringify({ version: 3 }));
    await writeFile(path.join(results, "comparison-oversized.json"), Buffer.alloc(MAX_COMPARISON_REPORT_BYTES + 1, 0x20));
    await writeFile(path.join(results, "not-a-comparison.json"), JSON.stringify({ version: 2 }));
    await symlink(outsidePath, path.join(results, "comparison-symlink.json"));

    await expect(readSttComparisonResult(root, "comparison-malformed.json")).resolves.toBeNull();
    await expect(readSttComparisonResult(root, "comparison-invalid-schema.json")).resolves.toBeNull();
    await expect(readSttComparisonResult(root, "comparison-oversized.json")).resolves.toBeNull();
    await expect(readSttComparisonResult(root, "comparison-symlink.json")).resolves.toBeNull();
    await expect(readSttComparisonResult(root, "not-a-comparison.json")).resolves.toBeNull();
  });
});

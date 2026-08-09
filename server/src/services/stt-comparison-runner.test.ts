import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FixtureRecording } from "./audio-fixtures.js";
import {
  buildComparisonRunDefinitions,
  comparisonRunResultSchema,
  fixtureScriptSchema,
  scoreComparisonRun,
  type ComparisonRunDefinition,
  type ComparisonRunResult
} from "./stt-comparison.js";
import {
  buildSttComparisonResultPath,
  createComparisonReport,
  createSttComparisonRunner,
  writeComparisonReportAtomically,
  type LoadedSttComparisonFixture,
  type SttComparisonProgress
} from "./stt-comparison-runner.js";
import { isValidSttComparisonResultFileName } from "./stt-comparison-results.js";

const RECORDING_ID = "123e4567-e89b-42d3-a456-426614174000";
const roots: string[] = [];

const script = fixtureScriptSchema.parse({
  id: "runner-v3",
  title: "runner fixture",
  languageCode: "ko-KR",
  text: "래그",
  targetTerms: [{
    id: "rag",
    canonicalTerm: "RAG",
    english: "Retrieval-Augmented Generation",
    spokenAliases: ["래그"],
    expectedOccurrences: [1]
  }]
});

const recording: FixtureRecording = {
  id: RECORDING_ID,
  fileName: `20260809000000-${RECORDING_ID}.wav`,
  relativePath: `audio/20260809000000-${RECORDING_ID}.wav`,
  scriptId: script.id,
  speakerLabel: "speaker-a",
  environment: "quiet",
  createdAt: "2026-08-09T00:00:00.000Z",
  durationMs: 100,
  sampleRate: 16_000,
  channels: 1,
  bitsPerSample: 16,
  dataBytes: 3_200,
  speakerReadReferenceScriptVerbatim: true
};

const fixture: LoadedSttComparisonFixture = {
  recording,
  script,
  pcm: Buffer.alloc(3_200)
};

function completedRun(definition: ComparisonRunDefinition): ComparisonRunResult {
  return comparisonRunResultSchema.parse({
    ...definition,
    status: "completed",
    startedAt: "2026-08-09T00:00:00.000Z",
    readyAfterMs: 1,
    audioDurationMs: 100,
    wallClockMs: 100,
    interimCount: 0,
    finalTranscripts: [],
    transcript: "",
    rawTranscript: "",
    ...scoreComparisonRun({
      runLabel: definition.label,
      script,
      finalTranscripts: [],
      speakerReadReferenceScriptVerbatim: true
    }),
    errors: []
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("reusable STT comparison runner", () => {
  it("runs A/B/C sequentially exactly once, forwards replay progress, and continues after a run error", async () => {
    const calls: string[] = [];
    const progress: SttComparisonProgress[] = [];
    let active = 0;
    let maximumActive = 0;
    const release = vi.fn(async () => true);
    const publishReport = vi.fn(async () => undefined);
    const delays: number[] = [];
    const runner = createSttComparisonRunner({
      loadFixture: async () => fixture,
      acquireLock: async () => ({
        record: {
          ownerToken: "123e4567-e89b-42d3-a456-426614174001",
          pid: 1,
          jobId: "job-42",
          owner: "ui",
          recordingId: RECORDING_ID,
          acquiredAt: "2026-08-09T00:00:00.000Z"
        },
        release
      }),
      executeRun: async (options) => {
        calls.push(options.definition.label);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        options.onReplayProgress?.({ sentBytes: 1_600, totalBytes: 3_200, fraction: 0.5 });
        active -= 1;
        if (options.definition.label === "canonical-phrase-set") throw new Error("synthetic B failure");
        return completedRun(options.definition);
      },
      publishReport,
      delayBetweenRuns: async (durationMs) => { delays.push(durationMs); },
      now: () => new Date("2026-08-09T01:00:00.000Z")
    });

    const outcome = await runner({
      fixtureRoot: "/virtual/fixtures",
      websocketUrl: "ws://127.0.0.1:8787/ws",
      recordingId: RECORDING_ID,
      jobId: "job-42",
      owner: "ui",
      onProgress: (event) => progress.push(event)
    });

    expect(calls).toEqual([
      "without-phrase-set",
      "canonical-phrase-set",
      "spoken-alias-phrase-set"
    ]);
    expect(maximumActive).toBe(1);
    expect(delays).toEqual([1_000, 1_000]);
    expect(outcome.report.version).toBe(4);
    expect(outcome.report.runs.map((run) => run.status)).toEqual(["completed", "error", "completed"]);
    expect(outcome.report.runs[1]?.errors).toEqual(["synthetic B failure"]);
    expect(outcome.hasRunErrors).toBe(true);
    expect(outcome.outputPath).toBe(
      `/virtual/fixtures/results/comparison-${RECORDING_ID}-job-42.json`
    );
    expect(progress.filter((event) => event.activeRun && event.replayProgress?.fraction === 0.5)
      .map((event) => event.activeRun?.label)).toEqual(calls);
    expect(progress.map((event) => event.phase)).toContain("writing-result");
    expect(publishReport).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("treats report publication failure as fatal and still releases the lock", async () => {
    const release = vi.fn(async () => true);
    const runner = createSttComparisonRunner({
      loadFixture: async () => fixture,
      acquireLock: async () => ({
        record: {
          ownerToken: "123e4567-e89b-42d3-a456-426614174001",
          pid: 1,
          jobId: "fatal-write",
          owner: "ui",
          recordingId: RECORDING_ID,
          acquiredAt: "2026-08-09T00:00:00.000Z"
        },
        release
      }),
      executeRun: async ({ definition }) => completedRun(definition),
      publishReport: async () => { throw new Error("disk full"); },
      delayBetweenRuns: async () => undefined,
      now: () => new Date("2026-08-09T01:00:00.000Z")
    });

    await expect(runner({
      fixtureRoot: "/virtual/fixtures",
      websocketUrl: "ws://127.0.0.1:8787/ws",
      recordingId: RECORDING_ID,
      jobId: "fatal-write",
      owner: "ui"
    })).rejects.toThrow("disk full");
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("strict v4 no-clobber report publication", () => {
  it("publishes a unique 0600 report atomically and never overwrites an existing result", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stt-comparison-result-"));
    roots.push(root);
    const runs = buildComparisonRunDefinitions(script).map(completedRun);
    const report = createComparisonReport({
      createdAt: "2026-08-09T01:00:00.000Z",
      recording,
      script,
      websocketUrl: "ws://127.0.0.1:8787/ws",
      runs
    });
    const outputPath = buildSttComparisonResultPath(root, RECORDING_ID, "job-a");

    expect(isValidSttComparisonResultFileName(path.basename(outputPath))).toBe(true);
    await writeComparisonReportAtomically(outputPath, report);
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(report);
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
    expect(await readdir(path.dirname(outputPath))).toEqual([path.basename(outputPath)]);

    await writeFile(outputPath, "existing report", { mode: 0o600 });
    await expect(writeComparisonReportAtomically(outputPath, report)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(outputPath, "utf8")).toBe("existing report");
    expect(await readdir(path.dirname(outputPath))).toEqual([path.basename(outputPath)]);
  });
});

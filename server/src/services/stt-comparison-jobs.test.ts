import { describe, expect, it, vi } from "vitest";
import {
  buildComparisonRunDefinitions,
  comparisonRunResultSchema,
  fixtureScriptSchema,
  scoreComparisonRun,
  type ComparisonReportV3
} from "./stt-comparison.js";
import { createComparisonReport, type SttComparisonRunner } from "./stt-comparison-runner.js";
import { SttComparisonJobManager } from "./stt-comparison-jobs.js";

const RECORDING_ID = "123e4567-e89b-42d3-a456-426614174000";

const script = fixtureScriptSchema.parse({
  id: "jobs-v3",
  title: "jobs fixture",
  languageCode: "ko-KR",
  text: "RAG",
  targetTerms: [{
    id: "rag",
    canonicalTerm: "RAG",
    english: "",
    spokenAliases: ["래그"],
    expectedOccurrences: [1]
  }]
});

function reportWithStatuses(statuses: Array<"completed" | "error">): ComparisonReportV3 {
  const runs = buildComparisonRunDefinitions(script).map((definition, index) => comparisonRunResultSchema.parse({
    ...definition,
    status: statuses[index],
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
    errors: statuses[index] === "error" ? [`${definition.label} failed`] : []
  }));
  return createComparisonReport({
    createdAt: "2026-08-09T00:01:00.000Z",
    recording: {
      id: RECORDING_ID,
      scriptId: script.id,
      speakerReadReferenceScriptVerbatim: true
    },
    script,
    websocketUrl: "ws://127.0.0.1:8787/ws",
    runs
  });
}

describe("in-memory STT comparison UI jobs", () => {
  it("moves through running and writing-result to completed", async () => {
    const observed: string[] = [];
    let parallelSnapshot: ReturnType<SttComparisonJobManager["getJob"]>;
    let manager: SttComparisonJobManager;
    const runner = vi.fn<SttComparisonRunner>(async (request) => {
      request.onProgress?.({
        phase: "running",
        jobId: request.jobId!,
        recordingId: RECORDING_ID,
        completedRuns: 0,
        totalRuns: 3,
        activeRun: null,
        replayProgress: null,
        runProgress: [
          { label: "without-phrase-set", index: 0, total: 3, state: "running", replayProgress: { sentBytes: 1_600, totalBytes: 3_200, fraction: 0.5 } },
          { label: "canonical-phrase-set", index: 1, total: 3, state: "running", replayProgress: { sentBytes: 1_600, totalBytes: 3_200, fraction: 0.5 } },
          { label: "spoken-alias-phrase-set", index: 2, total: 3, state: "running", replayProgress: { sentBytes: 1_600, totalBytes: 3_200, fraction: 0.5 } }
        ]
      });
      parallelSnapshot = manager.getJob(request.jobId!);
      observed.push(manager.getJob(request.jobId!)!.status);
      request.onProgress?.({
        phase: "writing-result",
        jobId: request.jobId!,
        recordingId: RECORDING_ID,
        completedRuns: 3,
        totalRuns: 3,
        activeRun: null,
        replayProgress: null,
        runProgress: [
          { label: "without-phrase-set", index: 0, total: 3, state: "completed", replayProgress: null },
          { label: "canonical-phrase-set", index: 1, total: 3, state: "completed", replayProgress: null },
          { label: "spoken-alias-phrase-set", index: 2, total: 3, state: "completed", replayProgress: null }
        ]
      });
      observed.push(manager.getJob(request.jobId!)!.status);
      const report = reportWithStatuses(["completed", "completed", "completed"]);
      return {
        jobId: request.jobId!,
        recordingId: RECORDING_ID,
        outputPath: "/fixtures/results/comparison-result.json",
        report,
        hasRunErrors: false
      };
    });
    manager = new SttComparisonJobManager({
      fixtureRoot: "/fixtures",
      websocketUrl: "ws://127.0.0.1:8787/ws",
      runner,
      randomJobId: () => "ui-job-1",
      now: () => new Date("2026-08-09T00:00:00.000Z")
    });

    const started = manager.start(RECORDING_ID);
    expect(started.status).toBe("starting");
    const finished = await manager.waitForJob(started.id);

    expect(observed).toEqual(["running", "writing-result"]);
    expect(parallelSnapshot).toMatchObject({
      status: "running",
      completedRuns: 0,
      progress: { completed: 0, total: 3, percent: 50 },
      activeRunLabel: null,
      message: "A/B/C 3개 조건을 병렬로 실행하고 있습니다.",
      runs: [
        { label: "without-phrase-set", state: "running", progress: 50 },
        { label: "canonical-phrase-set", state: "running", progress: 50 },
        { label: "spoken-alias-phrase-set", state: "running", progress: 50 }
      ]
    });
    expect(finished).toMatchObject({
      status: "completed",
      state: "completed",
      completedRuns: 3,
      progress: { completed: 3, total: 3, percent: 100 },
      activeRunLabel: null,
      resultPath: "/fixtures/results/comparison-result.json",
      resultFileName: "comparison-result.json",
      error: null,
      fatalError: null,
      runErrors: []
    });
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0]?.[0]).toMatchObject({
      recordingId: RECORDING_ID,
      jobId: "ui-job-1",
      owner: "ui"
    });
  });

  it("finishes as completed-with-errors when all three runs were written with a run error", async () => {
    const report = reportWithStatuses(["completed", "error", "completed"]);
    const runner: SttComparisonRunner = async (request) => ({
      jobId: request.jobId!,
      recordingId: RECORDING_ID,
      outputPath: "/fixtures/results/with-errors.json",
      report,
      hasRunErrors: true
    });
    const manager = new SttComparisonJobManager({
      fixtureRoot: "/fixtures",
      websocketUrl: "ws://127.0.0.1:8787/ws",
      runner,
      randomJobId: () => "ui-job-errors"
    });

    const finished = await manager.waitForJob(manager.startJob({ recordingId: RECORDING_ID }).id);

    expect(finished).toMatchObject({
      status: "completed-with-errors",
      state: "completed-with-errors",
      resultPath: "/fixtures/results/with-errors.json",
      resultFileName: "with-errors.json",
      runErrors: [{ label: "canonical-phrase-set", errors: ["canonical-phrase-set failed"] }],
      error: null
    });
  });

  it("marks lock, fixture, or fatal report failures as failed without retrying", async () => {
    const runner = vi.fn<SttComparisonRunner>(async () => {
      throw new Error("comparison report publication failed");
    });
    const manager = new SttComparisonJobManager({
      fixtureRoot: "/fixtures",
      websocketUrl: "ws://127.0.0.1:8787/ws",
      runner,
      randomJobId: () => "ui-job-failed"
    });

    const finished = await manager.waitForJob(manager.start(RECORDING_ID).id);

    expect(finished).toMatchObject({
      status: "failed",
      state: "failed",
      resultPath: null,
      error: "comparison report publication failed",
      fatalError: "comparison report publication failed"
    });
    expect(runner).toHaveBeenCalledOnce();
  });
});

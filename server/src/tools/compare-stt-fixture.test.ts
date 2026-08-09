import { describe, expect, it, vi } from "vitest";
import {
  buildComparisonRunDefinitions,
  comparisonRunResultSchema,
  fixtureScriptSchema,
  scoreComparisonRun
} from "../services/stt-comparison.js";
import {
  createComparisonReport,
  type SttComparisonRunner
} from "../services/stt-comparison-runner.js";
import { runComparisonCli, type ComparisonCliOutput } from "./compare-stt-fixture.js";

const RECORDING_ID = "123e4567-e89b-42d3-a456-426614174000";

function makeOutcome(hasRunErrors = false) {
  const script = fixtureScriptSchema.parse({
    id: "cli-v3",
    title: "CLI fixture",
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
  const runs = buildComparisonRunDefinitions(script).map((definition, index) => comparisonRunResultSchema.parse({
    ...definition,
    status: hasRunErrors && index === 1 ? "error" : "completed",
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
      speakerReadReferenceScriptVerbatim: false
    }),
    errors: hasRunErrors && index === 1 ? ["synthetic run error"] : []
  }));
  const report = createComparisonReport({
    createdAt: "2026-08-09T00:01:00.000Z",
    recording: {
      id: RECORDING_ID,
      scriptId: script.id,
      speakerReadReferenceScriptVerbatim: false
    },
    script,
    websocketUrl: "ws://localhost:9999/ws",
    runs
  });
  return {
    jobId: "cli-job",
    recordingId: RECORDING_ID,
    outputPath: `/workspace/test-fixtures/stt/results/comparison-${RECORDING_ID}-cli-job.json`,
    report,
    hasRunErrors
  };
}

describe("thin STT comparison CLI", () => {
  it("delegates one job to the shared runner with CLI ownership and prints its result", async () => {
    const logs: unknown[][] = [];
    const errors: unknown[][] = [];
    const tables: unknown[][] = [];
    const output: ComparisonCliOutput = {
      log: (...values) => { logs.push(values); },
      error: (...values) => { errors.push(values); },
      table: (...values) => { tables.push(values); }
    };
    const runner = vi.fn<SttComparisonRunner>(async (request) => {
      request.onProgress?.({
        phase: "running",
        jobId: "cli-job",
        recordingId: RECORDING_ID,
        completedRuns: 0,
        totalRuns: 3,
        activeRun: { label: "without-phrase-set", index: 0, total: 3 },
        replayProgress: { sentBytes: 0, totalBytes: 3_200, fraction: 0 }
      });
      return makeOutcome(false);
    });

    const exitCode = await runComparisonCli([RECORDING_ID], {
      runner,
      cwd: "/workspace",
      env: { STT_COMPARE_WS_URL: "ws://localhost:9999/ws" },
      output
    });

    expect(exitCode).toBe(0);
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0]?.[0]).toMatchObject({
      fixtureRoot: "/workspace/test-fixtures/stt",
      websocketUrl: "ws://localhost:9999/ws",
      recordingId: RECORDING_ID,
      owner: "cli"
    });
    expect(logs.flat().join("\n")).toContain("without-phrase-set");
    expect(logs.flat().join("\n")).toContain(`comparison-${RECORDING_ID}-cli-job.json`);
    expect(errors).toEqual([]);
    expect(tables).toHaveLength(1);
  });

  it("returns a nonzero code when the completed v3 report contains run errors", async () => {
    const runner: SttComparisonRunner = async () => makeOutcome(true);
    const output: ComparisonCliOutput = {
      log: vi.fn(),
      error: vi.fn(),
      table: vi.fn()
    };

    await expect(runComparisonCli([], {
      runner,
      cwd: "/workspace",
      env: { PORT: "8787" },
      output
    })).resolves.toBe(1);
    expect(output.error).toHaveBeenCalledWith("synthetic run error");
  });
});

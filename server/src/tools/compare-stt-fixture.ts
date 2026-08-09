import "dotenv/config";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  runSttComparison,
  type SttComparisonProgress,
  type SttComparisonRunner
} from "../services/stt-comparison-runner.js";

export {
  createComparisonReport,
  writeComparisonReportAtomically
} from "../services/stt-comparison-runner.js";

export type ComparisonCliOutput = Pick<Console, "log" | "error" | "table">;

export type ComparisonCliDependencies = {
  runner?: SttComparisonRunner;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  output?: ComparisonCliOutput;
};

function printProgress(
  progress: SttComparisonProgress,
  output: ComparisonCliOutput,
  announcedRuns: Set<number>
): void {
  if (progress.phase === "running" && progress.activeRun && !announcedRuns.has(progress.activeRun.index)) {
    announcedRuns.add(progress.activeRun.index);
    output.log(`\n[${progress.activeRun.label}] 고정 음원을 Google STT에 재생합니다.`);
  } else if (progress.phase === "writing-result") {
    output.log("\nA/B/C 실행이 끝났습니다. v3 결과를 저장합니다.");
  }
}

export async function runComparisonCli(
  argv: string[] = process.argv.slice(2),
  dependencies: ComparisonCliDependencies = {}
): Promise<number> {
  const cwd = dependencies.cwd ?? process.cwd();
  const env = dependencies.env ?? process.env;
  const output = dependencies.output ?? console;
  const runner = dependencies.runner ?? runSttComparison;
  const fixtureRoot = path.resolve(cwd, "test-fixtures/stt");
  const websocketUrl = env.STT_COMPARE_WS_URL || `ws://127.0.0.1:${env.PORT || 8787}/ws`;
  const announcedRuns = new Set<number>();
  const outcome = await runner({
    fixtureRoot,
    websocketUrl,
    recordingId: argv[0],
    owner: "cli",
    onProgress: (progress) => printProgress(progress, output, announcedRuns)
  });

  for (const run of outcome.report.runs) {
    const metrics = run.metrics;
    output.log(
      `[${run.label}] ${run.status}: 직접 ${metrics.directRecognitions}, 별칭 정정 ${metrics.aliasCorrectionSuccesses}, ` +
      `miss ${metrics.misses}, false correction ${metrics.falseCorrections}, false insertion ${metrics.falseInsertions} ` +
      `(${metrics.evaluationMode})`
    );
    if (run.errors.length) output.error(run.errors.join("\n"));
  }
  output.table(outcome.report.runs.map((run) => ({ label: run.label, ...run.metrics })));
  output.log(`\n비교 결과: ${path.relative(cwd, outcome.outputPath)}`);
  return outcome.hasRunErrors ? 1 : 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  void runComparisonCli().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

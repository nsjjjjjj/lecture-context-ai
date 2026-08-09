import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ComparisonRunLabel } from "./stt-comparison.js";
import {
  runSttComparison,
  type SttComparisonActiveRun,
  type SttComparisonProgress,
  type SttComparisonReplayProgress,
  type SttComparisonRunner,
  type SttComparisonRunnerOutcome
} from "./stt-comparison-runner.js";

export const sttComparisonJobStatuses = [
  "starting",
  "running",
  "writing-result",
  "completed",
  "completed-with-errors",
  "failed"
] as const;

export type JobStatus = typeof sttComparisonJobStatuses[number];

export type SttComparisonJobRunError = {
  label: ComparisonRunLabel;
  errors: string[];
};

export type SttComparisonJobRunState = "pending" | "running" | "completed" | "error";

export type SttComparisonJobRunStatus = {
  label: ComparisonRunLabel;
  state: SttComparisonJobRunState;
  message: string | null;
  error: string | null;
};

export type SttComparisonJobProgress = {
  completed: number;
  total: 3;
  percent: number;
};

export type SttComparisonJob = {
  id: string;
  recordingId: string;
  status: JobStatus;
  state: JobStatus;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  completedAt: string | null;
  completedRuns: number;
  totalRuns: 3;
  progress: SttComparisonJobProgress;
  activeRun: SttComparisonActiveRun | null;
  activeRunLabel: ComparisonRunLabel | null;
  replayProgress: SttComparisonReplayProgress | null;
  runs: SttComparisonJobRunStatus[];
  resultPath: string | null;
  resultFileName: string | null;
  runErrors: SttComparisonJobRunError[];
  message: string | null;
  error: string | null;
  fatalError: string | null;
};

export type StartSttComparisonJobInput = {
  recordingId: string;
};

export type SttComparisonJobManagerOptions = {
  fixtureRoot: string;
  websocketUrl: string;
  runner?: SttComparisonRunner;
  now?: () => Date;
  randomJobId?: () => string;
};

const RECORDING_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,90}$/;

function cloneActiveRun(activeRun: SttComparisonActiveRun | null): SttComparisonActiveRun | null {
  return activeRun ? { ...activeRun } : null;
}

function cloneReplayProgress(progress: SttComparisonReplayProgress | null): SttComparisonReplayProgress | null {
  return progress ? { ...progress } : null;
}

function cloneJob(job: SttComparisonJob): SttComparisonJob {
  return {
    ...job,
    activeRun: cloneActiveRun(job.activeRun),
    replayProgress: cloneReplayProgress(job.replayProgress),
    progress: { ...job.progress },
    runs: job.runs.map((run) => ({ ...run })),
    runErrors: job.runErrors.map((runError) => ({
      label: runError.label,
      errors: [...runError.errors]
    }))
  };
}

function initialRuns(): SttComparisonJobRunStatus[] {
  return ([
    "without-phrase-set",
    "canonical-phrase-set",
    "spoken-alias-phrase-set"
  ] satisfies ComparisonRunLabel[]).map((label) => ({
    label,
    state: "pending",
    message: null,
    error: null
  }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function isTerminal(status: JobStatus): boolean {
  return status === "completed" || status === "completed-with-errors" || status === "failed";
}

export class SttComparisonJobManager {
  private readonly jobs = new Map<string, SttComparisonJob>();
  private readonly executions = new Map<string, Promise<void>>();
  private readonly runner: SttComparisonRunner;
  private readonly now: () => Date;
  private readonly randomJobId: () => string;

  constructor(private readonly options: SttComparisonJobManagerOptions) {
    this.runner = options.runner ?? runSttComparison;
    this.now = options.now ?? (() => new Date());
    this.randomJobId = options.randomJobId ?? randomUUID;
  }

  start(recordingId: string): SttComparisonJob {
    return this.startJob({ recordingId });
  }

  startJob(input: StartSttComparisonJobInput): SttComparisonJob {
    if (!RECORDING_ID_PATTERN.test(input.recordingId)) throw new Error("STT 비교 recording ID가 올바르지 않습니다.");
    const id = this.randomJobId();
    if (!JOB_ID_PATTERN.test(id)) throw new Error("STT 비교 job ID가 올바르지 않습니다.");
    if (this.jobs.has(id)) throw new Error("STT 비교 job ID가 중복되었습니다.");
    const timestamp = this.now().toISOString();
    const job: SttComparisonJob = {
      id,
      recordingId: input.recordingId,
      status: "starting",
      state: "starting",
      createdAt: timestamp,
      startedAt: null,
      updatedAt: timestamp,
      finishedAt: null,
      completedAt: null,
      completedRuns: 0,
      totalRuns: 3,
      progress: { completed: 0, total: 3, percent: 0 },
      activeRun: null,
      activeRunLabel: null,
      replayProgress: null,
      runs: initialRuns(),
      resultPath: null,
      resultFileName: null,
      runErrors: [],
      message: "STT 비교 작업을 시작합니다.",
      error: null,
      fatalError: null
    };
    this.jobs.set(id, job);

    const execution = Promise.resolve().then(() => this.execute(job.id));
    this.executions.set(id, execution);
    const cleanup = (): void => {
      if (this.executions.get(id) === execution) this.executions.delete(id);
    };
    void execution.then(cleanup, cleanup);
    return cloneJob(job);
  }

  get(id: string): SttComparisonJob | undefined {
    return this.getJob(id);
  }

  getJob(id: string): SttComparisonJob | undefined {
    const job = this.jobs.get(id);
    return job ? cloneJob(job) : undefined;
  }

  list(): SttComparisonJob[] {
    return this.listJobs();
  }

  listJobs(): SttComparisonJob[] {
    return [...this.jobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(cloneJob);
  }

  getActiveJob(): SttComparisonJob | undefined {
    const active = [...this.jobs.values()].reverse().find((job) => !isTerminal(job.status));
    return active ? cloneJob(active) : undefined;
  }

  getCurrentJob(): SttComparisonJob | undefined {
    return this.getActiveJob();
  }

  async waitForJob(id: string): Promise<SttComparisonJob | undefined> {
    await this.executions.get(id);
    return this.getJob(id);
  }

  private timestamp(job: SttComparisonJob): string {
    const value = this.now().toISOString();
    job.updatedAt = value;
    return value;
  }

  private applyProgress(jobId: string, progress: SttComparisonProgress): void {
    const job = this.jobs.get(jobId);
    if (!job || isTerminal(job.status)) return;
    if (progress.phase === "running") {
      if (job.status !== "writing-result") job.status = "running";
    } else if (progress.phase === "writing-result") {
      job.status = "writing-result";
    }
    if (progress.phase === "running" && job.status === "writing-result") return;
    job.state = job.status;
    job.completedRuns = progress.completedRuns;
    job.activeRun = cloneActiveRun(progress.activeRun);
    job.activeRunLabel = progress.activeRun?.label ?? null;
    job.replayProgress = cloneReplayProgress(progress.replayProgress);
    const replayFraction = progress.activeRun ? (progress.replayProgress?.fraction ?? 0) : 0;
    job.progress = {
      completed: progress.completedRuns,
      total: 3,
      percent: Math.min(100, Math.max(0, ((progress.completedRuns + replayFraction) / 3) * 100))
    };
    job.runs = job.runs.map((run, index) => ({
      ...run,
      state: run.label === progress.activeRun?.label
        ? "running"
        : index < progress.completedRuns
          ? "completed"
          : "pending",
      message: run.label === progress.activeRun?.label
        ? "고정 음원 재생 중"
        : index < progress.completedRuns
          ? "실행 완료"
          : null
    }));
    job.message = progress.phase === "writing-result"
      ? "A/B/C 결과를 v3 리포트로 저장하고 있습니다."
      : progress.activeRun
        ? `${progress.activeRun.label} 조건을 실행하고 있습니다.`
        : "다음 STT 비교 조건을 준비하고 있습니다.";
    this.timestamp(job);
  }

  private complete(job: SttComparisonJob, outcome: SttComparisonRunnerOutcome): void {
    job.status = outcome.hasRunErrors ? "completed-with-errors" : "completed";
    job.state = job.status;
    job.completedRuns = 3;
    job.progress = { completed: 3, total: 3, percent: 100 };
    job.activeRun = null;
    job.activeRunLabel = null;
    job.replayProgress = null;
    job.resultPath = outcome.outputPath;
    job.resultFileName = path.basename(outcome.outputPath);
    job.runErrors = outcome.report.runs
      .filter((run) => run.status === "error")
      .map((run) => ({ label: run.label, errors: [...run.errors] }));
    job.runs = outcome.report.runs.map((run) => ({
      label: run.label,
      state: run.status === "error" ? "error" : "completed",
      message: run.status === "error" ? "오류를 기록하고 다음 조건을 계속 실행했습니다." : "실행 완료",
      error: run.errors.join("\n") || null
    }));
    job.message = outcome.hasRunErrors
      ? "일부 조건의 오류를 포함한 v3 결과를 저장했습니다."
      : "A/B/C v3 결과를 저장했습니다.";
    job.finishedAt = this.timestamp(job);
    job.completedAt = job.finishedAt;
  }

  private fail(job: SttComparisonJob, error: unknown): void {
    job.status = "failed";
    job.state = "failed";
    job.activeRun = null;
    job.activeRunLabel = null;
    job.replayProgress = null;
    job.error = errorMessage(error);
    job.fatalError = job.error;
    job.message = "STT 비교 작업을 완료하지 못했습니다.";
    job.finishedAt = this.timestamp(job);
    job.completedAt = job.finishedAt;
  }

  private async execute(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.startedAt = this.timestamp(job);
    try {
      const outcome = await this.runner({
        fixtureRoot: this.options.fixtureRoot,
        websocketUrl: this.options.websocketUrl,
        recordingId: job.recordingId,
        jobId: job.id,
        owner: "ui",
        onProgress: (progress) => this.applyProgress(job.id, progress)
      });
      this.complete(job, outcome);
    } catch (error) {
      this.fail(job, error);
    }
  }
}

export function createSttComparisonJobManager(
  options: SttComparisonJobManagerOptions
): SttComparisonJobManager {
  return new SttComparisonJobManager(options);
}

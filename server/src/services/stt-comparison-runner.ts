import { randomUUID } from "node:crypto";
import { lstat, link, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import WebSocket from "ws";
import {
  AudioFixtureStore,
  FIXTURE_BYTES_PER_SECOND,
  splitPcmForSpeech,
  type FixtureRecording
} from "./audio-fixtures.js";
import {
  buildComparisonRunDefinitions,
  comparisonFinalTranscriptSchema,
  comparisonReportV3Schema,
  comparisonRunResultSchema,
  scoreComparisonRun,
  type ComparisonFinalTranscript,
  type ComparisonReportV3,
  type ComparisonRunDefinition,
  type ComparisonRunLabel,
  type ComparisonRunResult,
  type FixtureScript
} from "./stt-comparison.js";
import {
  acquireSttComparisonLock,
  STT_COMPARISON_LOCK_FILE,
  type AcquireSttComparisonLockOptions,
  type SttComparisonLock,
  type SttComparisonLockOwner
} from "./stt-comparison-lock.js";
import type { StartMessage, TranscriptEvent } from "../types.js";

export const STT_COMPARISON_REPLAY_CHUNK_BYTES = 3_200;
export const STT_COMPARISON_RUN_GRACE_MS = 30_000;
export const STT_COMPARISON_INTER_RUN_DELAY_MS = 1_000;
export const STT_COMPARISON_RUN_COUNT = 3;

export type SttComparisonActiveRun = {
  label: ComparisonRunLabel;
  index: number;
  total: typeof STT_COMPARISON_RUN_COUNT;
};

export type SttComparisonReplayProgress = {
  sentBytes: number;
  totalBytes: number;
  fraction: number;
};

export type SttComparisonProgress = {
  phase: "starting" | "running" | "writing-result" | "completed";
  jobId: string;
  recordingId: string;
  completedRuns: number;
  totalRuns: typeof STT_COMPARISON_RUN_COUNT;
  activeRun: SttComparisonActiveRun | null;
  replayProgress: SttComparisonReplayProgress | null;
};

export type LoadedSttComparisonFixture = {
  recording: FixtureRecording;
  script: FixtureScript;
  pcm: Buffer;
};

export type ExecuteSttComparisonRunOptions = {
  definition: ComparisonRunDefinition;
  websocketUrl: string;
  pcm: Buffer;
  script: FixtureScript;
  speakerReadReferenceScriptVerbatim: boolean;
  onReplayProgress?: (progress: SttComparisonReplayProgress) => void;
};

export type SttComparisonRunExecutor = (
  options: ExecuteSttComparisonRunOptions
) => Promise<ComparisonRunResult>;

export type SttComparisonRunnerRequest = {
  fixtureRoot: string;
  websocketUrl: string;
  recordingId?: string;
  jobId?: string;
  owner: SttComparisonLockOwner;
  onProgress?: (progress: SttComparisonProgress) => void;
};

export type SttComparisonRunnerOutcome = {
  jobId: string;
  recordingId: string;
  outputPath: string;
  report: ComparisonReportV3;
  hasRunErrors: boolean;
};

export type SttComparisonRunner = (
  request: SttComparisonRunnerRequest
) => Promise<SttComparisonRunnerOutcome>;

export type SttComparisonRunnerDependencies = {
  loadFixture?: (fixtureRoot: string, recordingId?: string) => Promise<LoadedSttComparisonFixture>;
  executeRun?: SttComparisonRunExecutor;
  acquireLock?: (options: AcquireSttComparisonLockOptions) => Promise<SttComparisonLock>;
  publishReport?: (outputPath: string, report: ComparisonReportV3) => Promise<void>;
  delayBetweenRuns?: (durationMs: number) => Promise<void>;
  now?: () => Date;
  randomJobId?: () => string;
};

// UUID recording id + separator + job id must stay within the result reader's 128-character suffix boundary.
const SAFE_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,90}$/;
const RECORDING_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function notifyProgress(
  callback: SttComparisonRunnerRequest["onProgress"],
  progress: SttComparisonProgress
): void {
  try {
    callback?.(progress);
  } catch {
    // Progress observers must not alter a paid, non-retryable comparison run.
  }
}

function send(socket: WebSocket, payload: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(payload, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function executeSttComparisonRun(
  options: ExecuteSttComparisonRunOptions
): Promise<ComparisonRunResult> {
  const chunks = splitPcmForSpeech(options.pcm, STT_COMPARISON_REPLAY_CHUNK_BYTES);
  const audioDurationMs = Math.round((options.pcm.length / FIXTURE_BYTES_PER_SECOND) * 1_000);
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const finalTranscripts: ComparisonFinalTranscript[] = [];
  const errors: string[] = [];
  let interimCount = 0;
  let readyAfterMs: number | null = null;
  let playbackStarted = false;

  return new Promise<ComparisonRunResult>((resolve) => {
    const socket = new WebSocket(options.websocketUrl);
    let settled = false;
    const timeout = setTimeout(
      () => finish("error", "STT 비교 실행 시간이 초과되었습니다."),
      audioDurationMs + STT_COMPARISON_RUN_GRACE_MS
    );

    const finish = (status: "completed" | "error", runError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (runError && !errors.includes(runError)) errors.push(runError);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();

      const transcript = finalTranscripts.map((event) => event.text).join(" ").trim();
      const rawTranscript = finalTranscripts.map((event) => event.rawText).join(" ").trim();
      const score = scoreComparisonRun({
        runLabel: options.definition.label,
        script: options.script,
        finalTranscripts,
        speakerReadReferenceScriptVerbatim: options.speakerReadReferenceScriptVerbatim
      });
      resolve(comparisonRunResultSchema.parse({
        label: options.definition.label,
        status,
        phraseSet: options.definition.phraseSet,
        terms: options.definition.terms,
        startedAt,
        readyAfterMs,
        audioDurationMs,
        wallClockMs: Date.now() - startedAtMs,
        interimCount,
        finalTranscripts,
        transcript,
        rawTranscript,
        ...score,
        errors
      }));
    };

    const replay = async (): Promise<void> => {
      let sentBytes = 0;
      for (const chunk of chunks) {
        if (settled || socket.readyState !== WebSocket.OPEN) return;
        await send(socket, chunk);
        sentBytes += chunk.length;
        options.onReplayProgress?.({
          sentBytes,
          totalBytes: options.pcm.length,
          fraction: sentBytes / options.pcm.length
        });
        await wait((chunk.length / FIXTURE_BYTES_PER_SECOND) * 1_000);
      }
      if (!settled && socket.readyState === WebSocket.OPEN) {
        await send(socket, JSON.stringify({ type: "stop" }));
      }
    };

    socket.on("open", () => {
      const startMessage: StartMessage = {
        type: "start",
        mode: "live",
        terms: options.definition.terms,
        phraseSet: options.definition.phraseSet
      };
      void send(socket, JSON.stringify(startMessage)).catch((error: unknown) => finish("error", errorMessage(error)));
    });

    socket.on("message", (raw) => {
      try {
        const event = JSON.parse(raw.toString()) as TranscriptEvent;
        if (event.type === "ready" && !playbackStarted) {
          playbackStarted = true;
          readyAfterMs = Date.now() - startedAtMs;
          void replay().catch((error: unknown) => finish("error", errorMessage(error)));
        } else if (event.type === "interim") {
          interimCount += 1;
        } else if (event.type === "final" && event.text) {
          finalTranscripts.push(comparisonFinalTranscriptSchema.parse({
            text: event.text,
            rawText: event.rawText ?? event.text,
            detectedTermIds: event.detectedTerms ?? [],
            corrections: event.corrections ?? []
          }));
        } else if (event.type === "error") {
          finish("error", event.message || "Google STT가 오류를 반환했습니다.");
        } else if (event.type === "ended") {
          finish(errors.length ? "error" : "completed");
        }
      } catch (error) {
        finish("error", error instanceof SyntaxError
          ? "서버가 해석할 수 없는 STT 이벤트를 반환했습니다."
          : errorMessage(error));
      }
    });

    socket.on("error", (error) => finish("error", error.message));
    socket.on("close", () => {
      if (!settled) finish("error", "자막 WebSocket 연결이 결과를 받기 전에 종료되었습니다.");
    });
  });
}

export function createComparisonReport(options: {
  createdAt: string;
  recording: Pick<FixtureRecording, "id" | "scriptId" | "speakerReadReferenceScriptVerbatim">;
  script: FixtureScript;
  websocketUrl: string;
  runs: ComparisonRunResult[];
}): ComparisonReportV3 {
  const evaluationMode = options.recording.speakerReadReferenceScriptVerbatim ? "accuracy" : "smoke";
  return comparisonReportV3Schema.parse({
    version: 3,
    createdAt: options.createdAt,
    recording: {
      id: options.recording.id,
      scriptId: options.recording.scriptId,
      speakerReadReferenceScriptVerbatim: options.recording.speakerReadReferenceScriptVerbatim,
      evaluationMode
    },
    script: options.script,
    websocketUrl: options.websocketUrl,
    measurementNote: evaluationMode === "accuracy"
      ? "화자가 기준 문장을 그대로 읽었다고 명시적으로 선언한 녹음입니다. occurrence-level 지표를 정확도 비교에 사용할 수 있습니다."
      : "기준 문장 그대로 읽기 선언이 없는 legacy/미검증 녹음입니다. 지표는 연결 동작 smoke 관찰용이며 정확도로 해석할 수 없습니다.",
    runs: options.runs
  });
}

async function assertSafeResultsDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("STT 비교 결과 경로가 안전한 디렉터리가 아닙니다.");
  }
}

export async function writeComparisonReportAtomically(
  outputPath: string,
  report: ComparisonReportV3
): Promise<void> {
  const validated = comparisonReportV3Schema.parse(report);
  const serialized = `${JSON.stringify(validated, null, 2)}\n`;
  const outputDirectory = path.dirname(outputPath);
  await assertSafeResultsDirectory(outputDirectory);
  const temporaryPath = path.join(
    outputDirectory,
    `.${path.basename(outputPath)}.tmp-${process.pid}-${randomUUID()}`
  );
  let handle: FileHandle | null = null;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(serialized, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = null;
    await link(temporaryPath, outputPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export function buildSttComparisonResultPath(
  fixtureRoot: string,
  recordingId: string,
  jobId: string
): string {
  if (!RECORDING_ID_PATTERN.test(recordingId)) throw new Error("STT 비교 recording ID가 파일 이름에 안전하지 않습니다.");
  if (!SAFE_JOB_ID_PATTERN.test(jobId)) throw new Error("STT 비교 job ID가 파일 이름에 안전하지 않습니다.");
  return path.join(path.resolve(fixtureRoot), "results", `comparison-${recordingId}-${jobId}.json`);
}

async function loadFixture(
  fixtureRoot: string,
  requestedRecordingId?: string
): Promise<LoadedSttComparisonFixture> {
  const store = new AudioFixtureStore(fixtureRoot);
  const catalog = await store.getCatalog();
  const selected = requestedRecordingId
    ? catalog.recordings.find((recording) => recording.id === requestedRecordingId)
    : catalog.recordings.at(-1);
  if (!selected) {
    throw new Error(requestedRecordingId ? "요청한 녹음 ID를 찾을 수 없습니다." : "저장된 녹음이 없습니다.");
  }
  const script = catalog.scripts.find((candidate) => candidate.id === selected.scriptId);
  if (!script) throw new Error("녹음에 연결된 고정 실험 문장을 찾을 수 없습니다.");
  const { pcm, recording } = await store.loadPcm(selected.id);
  return { pcm, recording, script };
}

function failedRunResult(options: {
  definition: ComparisonRunDefinition;
  fixture: LoadedSttComparisonFixture;
  startedAt: string;
  wallClockMs: number;
  error: unknown;
}): ComparisonRunResult {
  const score = scoreComparisonRun({
    runLabel: options.definition.label,
    script: options.fixture.script,
    finalTranscripts: [],
    speakerReadReferenceScriptVerbatim: options.fixture.recording.speakerReadReferenceScriptVerbatim
  });
  return comparisonRunResultSchema.parse({
    ...options.definition,
    status: "error",
    startedAt: options.startedAt,
    readyAfterMs: null,
    audioDurationMs: Math.round((options.fixture.pcm.length / FIXTURE_BYTES_PER_SECOND) * 1_000),
    wallClockMs: Math.max(0, options.wallClockMs),
    interimCount: 0,
    finalTranscripts: [],
    transcript: "",
    rawTranscript: "",
    ...score,
    errors: [errorMessage(options.error)]
  });
}

export function createSttComparisonRunner(
  dependencies: SttComparisonRunnerDependencies = {}
): SttComparisonRunner {
  const load = dependencies.loadFixture ?? loadFixture;
  const executeRun = dependencies.executeRun ?? executeSttComparisonRun;
  const acquireLock = dependencies.acquireLock ?? acquireSttComparisonLock;
  const publishReport = dependencies.publishReport ?? writeComparisonReportAtomically;
  const delayBetweenRuns = dependencies.delayBetweenRuns ?? wait;
  const now = dependencies.now ?? (() => new Date());
  const randomJobId = dependencies.randomJobId ?? randomUUID;

  return async (request): Promise<SttComparisonRunnerOutcome> => {
    const fixtureRoot = path.resolve(request.fixtureRoot);
    const jobId = request.jobId ?? randomJobId();
    if (!SAFE_JOB_ID_PATTERN.test(jobId)) throw new Error("STT 비교 job ID가 올바르지 않습니다.");
    const fixture = await load(fixtureRoot, request.recordingId);
    const lock = await acquireLock({
      lockPath: path.join(fixtureRoot, STT_COMPARISON_LOCK_FILE),
      jobId,
      owner: request.owner,
      recordingId: fixture.recording.id
    });

    try {
      notifyProgress(request.onProgress, {
        phase: "starting",
        jobId,
        recordingId: fixture.recording.id,
        completedRuns: 0,
        totalRuns: STT_COMPARISON_RUN_COUNT,
        activeRun: null,
        replayProgress: null
      });
      const definitions = buildComparisonRunDefinitions(fixture.script);
      const runs: ComparisonRunResult[] = [];

      for (const [index, definition] of definitions.entries()) {
        const activeRun: SttComparisonActiveRun = {
          label: definition.label,
          index,
          total: STT_COMPARISON_RUN_COUNT
        };
        notifyProgress(request.onProgress, {
          phase: "running",
          jobId,
          recordingId: fixture.recording.id,
          completedRuns: index,
          totalRuns: STT_COMPARISON_RUN_COUNT,
          activeRun,
          replayProgress: { sentBytes: 0, totalBytes: fixture.pcm.length, fraction: 0 }
        });

        const runStartedAt = now();
        let result: ComparisonRunResult;
        try {
          result = comparisonRunResultSchema.parse(await executeRun({
            definition,
            websocketUrl: request.websocketUrl,
            pcm: fixture.pcm,
            script: fixture.script,
            speakerReadReferenceScriptVerbatim: fixture.recording.speakerReadReferenceScriptVerbatim,
            onReplayProgress: (replayProgress) => notifyProgress(request.onProgress, {
              phase: "running",
              jobId,
              recordingId: fixture.recording.id,
              completedRuns: index,
              totalRuns: STT_COMPARISON_RUN_COUNT,
              activeRun,
              replayProgress
            })
          }));
        } catch (error) {
          result = failedRunResult({
            definition,
            fixture,
            startedAt: runStartedAt.toISOString(),
            wallClockMs: now().getTime() - runStartedAt.getTime(),
            error
          });
        }
        runs.push(result);
        notifyProgress(request.onProgress, {
          phase: "running",
          jobId,
          recordingId: fixture.recording.id,
          completedRuns: index + 1,
          totalRuns: STT_COMPARISON_RUN_COUNT,
          activeRun: null,
          replayProgress: null
        });
        if (index < definitions.length - 1) await delayBetweenRuns(STT_COMPARISON_INTER_RUN_DELAY_MS);
      }

      notifyProgress(request.onProgress, {
        phase: "writing-result",
        jobId,
        recordingId: fixture.recording.id,
        completedRuns: STT_COMPARISON_RUN_COUNT,
        totalRuns: STT_COMPARISON_RUN_COUNT,
        activeRun: null,
        replayProgress: null
      });
      const report = createComparisonReport({
        createdAt: now().toISOString(),
        recording: fixture.recording,
        script: fixture.script,
        websocketUrl: request.websocketUrl,
        runs
      });
      const outputPath = buildSttComparisonResultPath(fixtureRoot, fixture.recording.id, jobId);
      await publishReport(outputPath, report);
      const hasRunErrors = runs.some((run) => run.status === "error");
      notifyProgress(request.onProgress, {
        phase: "completed",
        jobId,
        recordingId: fixture.recording.id,
        completedRuns: STT_COMPARISON_RUN_COUNT,
        totalRuns: STT_COMPARISON_RUN_COUNT,
        activeRun: null,
        replayProgress: null
      });
      return { jobId, recordingId: fixture.recording.id, outputPath, report, hasRunErrors };
    } finally {
      await lock.release();
    }
  };
}

export const runSttComparison = createSttComparisonRunner();

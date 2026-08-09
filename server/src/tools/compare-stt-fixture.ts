import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import {
  AudioFixtureStore,
  FIXTURE_BYTES_PER_SECOND,
  splitPcmForSpeech,
  type FixtureRecording
} from "../services/audio-fixtures.js";
import {
  buildComparisonRunDefinitions,
  comparisonFinalTranscriptSchema,
  comparisonReportV3Schema,
  comparisonRunResultSchema,
  scoreComparisonRun,
  type ComparisonFinalTranscript,
  type ComparisonReportV3,
  type ComparisonRunDefinition,
  type ComparisonRunResult,
  type FixtureScript
} from "../services/stt-comparison.js";
import type { StartMessage, TranscriptEvent } from "../types.js";

const REPLAY_CHUNK_BYTES = 3_200;
const RUN_GRACE_MS = 30_000;

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function send(socket: WebSocket, payload: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(payload, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function runFixture(options: {
  definition: ComparisonRunDefinition;
  websocketUrl: string;
  pcm: Buffer;
  script: FixtureScript;
  speakerReadReferenceScriptVerbatim: boolean;
}): Promise<ComparisonRunResult> {
  const chunks = splitPcmForSpeech(options.pcm, REPLAY_CHUNK_BYTES);
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
    const timeout = setTimeout(() => finish("error", "STT 비교 실행 시간이 초과되었습니다."), audioDurationMs + RUN_GRACE_MS);

    const finish = (status: "completed" | "error", errorMessage?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (errorMessage && !errors.includes(errorMessage)) errors.push(errorMessage);
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
      for (const chunk of chunks) {
        if (settled || socket.readyState !== WebSocket.OPEN) return;
        await send(socket, chunk);
        await delay((chunk.length / FIXTURE_BYTES_PER_SECOND) * 1_000);
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
      void send(socket, JSON.stringify(startMessage)).catch((error: unknown) => {
        finish("error", error instanceof Error ? error.message : String(error));
      });
    });

    socket.on("message", (raw) => {
      let event: TranscriptEvent;
      try {
        event = JSON.parse(raw.toString()) as TranscriptEvent;
      } catch {
        finish("error", "서버가 해석할 수 없는 STT 이벤트를 반환했습니다.");
        return;
      }

      if (event.type === "ready" && !playbackStarted) {
        playbackStarted = true;
        readyAfterMs = Date.now() - startedAtMs;
        void replay().catch((error: unknown) => {
          finish("error", error instanceof Error ? error.message : String(error));
        });
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

export async function writeComparisonReportAtomically(
  outputPath: string,
  report: ComparisonReportV3
): Promise<void> {
  const validated = comparisonReportV3Schema.parse(report);
  const serialized = `${JSON.stringify(validated, null, 2)}\n`;
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.tmp-${process.pid}-${randomUUID()}`
  );
  try {
    await writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, outputPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const fixtureRoot = path.resolve(process.cwd(), "test-fixtures/stt");
  const store = new AudioFixtureStore(fixtureRoot);
  const catalog = await store.getCatalog();
  const requestedRecordingId = process.argv[2];
  const selected = requestedRecordingId
    ? catalog.recordings.find((recording) => recording.id === requestedRecordingId)
    : catalog.recordings.at(-1);
  if (!selected) throw new Error(requestedRecordingId ? "요청한 녹음 ID를 찾을 수 없습니다." : "저장된 녹음이 없습니다.");

  const script = catalog.scripts.find((candidate) => candidate.id === selected.scriptId);
  if (!script) throw new Error("녹음에 연결된 고정 실험 문장을 찾을 수 없습니다.");

  const { pcm, recording } = await store.loadPcm(selected.id);
  const websocketUrl = process.env.STT_COMPARE_WS_URL || `ws://127.0.0.1:${process.env.PORT || 8787}/ws`;
  const definitions = buildComparisonRunDefinitions(script);
  const runs: ComparisonRunResult[] = [];

  for (const [index, definition] of definitions.entries()) {
    console.log(`\n[${definition.label}] ${Math.round(recording.durationMs / 1_000)}초 음원을 Google STT에 재생합니다.`);
    const result = await runFixture({
      definition,
      websocketUrl,
      pcm,
      script,
      speakerReadReferenceScriptVerbatim: recording.speakerReadReferenceScriptVerbatim
    });
    runs.push(result);
    const metrics = result.metrics;
    console.log(
      `[${definition.label}] ${result.status}: 직접 ${metrics.directRecognitions}, 별칭 정정 ${metrics.aliasCorrectionSuccesses}, ` +
      `miss ${metrics.misses}, false correction ${metrics.falseCorrections}, false insertion ${metrics.falseInsertions} ` +
      `(${metrics.evaluationMode})`
    );
    if (result.errors.length) console.error(result.errors.join("\n"));
    if (index < definitions.length - 1) await delay(1_000);
  }

  const report = createComparisonReport({
    createdAt: new Date().toISOString(),
    recording,
    script,
    websocketUrl,
    runs
  });
  const resultsRoot = path.join(fixtureRoot, "results");
  const outputPath = path.join(resultsRoot, `comparison-${recording.id}.json`);
  await mkdir(resultsRoot, { recursive: true });
  await writeComparisonReportAtomically(outputPath, report);

  console.table(report.runs.map((run) => ({ label: run.label, ...run.metrics })));
  console.log(`\n비교 결과: ${path.relative(process.cwd(), outputPath)}`);
  if (runs.some((run) => run.status === "error")) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

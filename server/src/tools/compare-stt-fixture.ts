import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import { z } from "zod";
import {
  AudioFixtureStore,
  FIXTURE_BYTES_PER_SECOND,
  splitPcmForSpeech
} from "../services/audio-fixtures.js";
import { findTranscriptTermMatches } from "../services/caption.js";
import type { GlossaryTerm, StartMessage, TranscriptCorrection, TranscriptEvent } from "../types.js";

const REPLAY_CHUNK_BYTES = 3_200;
const RUN_GRACE_MS = 30_000;

const manifestSchema = z.object({
  version: z.literal(1),
  recordings: z.array(z.object({
    id: z.string().uuid(),
    scriptId: z.string().min(1)
  }).passthrough()).min(1)
}).strict();

const scriptsSchema = z.object({
  version: z.literal(1),
  scripts: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    targetTerms: z.array(z.string().min(2)).min(1).max(50)
  }).passthrough()).min(1)
}).strict();

type FixtureRunLabel = "without-phrase-set" | "with-phrase-set";

type FinalTranscript = {
  text: string;
  rawText: string;
  detectedTermIds: string[];
  corrections: TranscriptCorrection[];
};

type FixtureRunResult = {
  label: FixtureRunLabel;
  status: "completed" | "error";
  phraseSet: string[];
  startedAt: string;
  readyAfterMs: number | null;
  audioDurationMs: number;
  wallClockMs: number;
  interimCount: number;
  finalTranscripts: FinalTranscript[];
  transcript: string;
  rawTranscript: string;
  recognizedTerms: string[];
  unrecognizedTerms: string[];
  errors: string[];
};

type ComparisonReport = {
  version: 2;
  createdAt: string;
  recordingId: string;
  scriptId: string;
  scriptTitle: string;
  websocketUrl: string;
  targetTerms: string[];
  measurementNote: string;
  runs: FixtureRunResult[];
  comparison: Array<{
    term: string;
    withoutPhraseSet: boolean;
    withPhraseSet: boolean;
  }>;
};

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export function buildFixtureTerms(targetTerms: string[]): GlossaryTerm[] {
  return targetTerms.map((term, index) => ({
    id: `fixture-term-${String(index + 1).padStart(2, "0")}`,
    term,
    english: term,
    spokenAliases: [],
    easyExplanation: "고정음원 STT 비교용 전문용어",
    pageNumber: 1,
    occurrences: 1,
    source: "demo"
  }));
}

export function findRecognizedTerms(
  targetTerms: string[],
  terms: GlossaryTerm[],
  finalTranscripts: FinalTranscript[]
): string[] {
  const exactTerms = terms.map((term) => ({ ...term, spokenAliases: [] }));
  const detectedIds = new Set(
    finalTranscripts.flatMap((event) => findTranscriptTermMatches(event.rawText, exactTerms).map((match) => match.term.id))
  );
  const idByTerm = new Map(exactTerms.map((term) => [term.term, term.id]));
  return targetTerms.filter((term) => detectedIds.has(idByTerm.get(term) ?? ""));
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
  label: FixtureRunLabel;
  websocketUrl: string;
  pcm: Buffer;
  terms: GlossaryTerm[];
  targetTerms: string[];
  phraseSet: string[];
}): Promise<FixtureRunResult> {
  const chunks = splitPcmForSpeech(options.pcm, REPLAY_CHUNK_BYTES);
  const audioDurationMs = Math.round((options.pcm.length / FIXTURE_BYTES_PER_SECOND) * 1_000);
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const finalTranscripts: FinalTranscript[] = [];
  const errors: string[] = [];
  let interimCount = 0;
  let readyAfterMs: number | null = null;
  let playbackStarted = false;

  return new Promise<FixtureRunResult>((resolve) => {
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
      const recognizedTerms = findRecognizedTerms(options.targetTerms, options.terms, finalTranscripts);

      resolve({
        label: options.label,
        status,
        phraseSet: options.phraseSet,
        startedAt,
        readyAfterMs,
        audioDurationMs,
        wallClockMs: Date.now() - startedAtMs,
        interimCount,
        finalTranscripts,
        transcript,
        rawTranscript,
        recognizedTerms,
        unrecognizedTerms: options.targetTerms.filter((term) => !recognizedTerms.includes(term)),
        errors
      });
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
        terms: options.terms,
        phraseSet: options.phraseSet
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
        finalTranscripts.push({
          text: event.text,
          rawText: event.rawText ?? event.text,
          detectedTermIds: event.detectedTerms ?? [],
          corrections: event.corrections ?? []
        });
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

async function main(): Promise<void> {
  const fixtureRoot = path.resolve(process.cwd(), "test-fixtures/stt");
  const manifest = manifestSchema.parse(JSON.parse(await readFile(path.join(fixtureRoot, "manifest.local.json"), "utf8")));
  const scripts = scriptsSchema.parse(JSON.parse(await readFile(path.join(fixtureRoot, "scripts.json"), "utf8")));
  const requestedRecordingId = process.argv[2];
  const selected = requestedRecordingId
    ? manifest.recordings.find((recording) => recording.id === requestedRecordingId)
    : manifest.recordings.at(-1);
  if (!selected) throw new Error(requestedRecordingId ? "요청한 녹음 ID를 찾을 수 없습니다." : "저장된 녹음이 없습니다.");

  const script = scripts.scripts.find((candidate) => candidate.id === selected.scriptId);
  if (!script) throw new Error("녹음에 연결된 고정 실험 문장을 찾을 수 없습니다.");

  const { pcm, recording } = await new AudioFixtureStore(fixtureRoot).loadPcm(selected.id);
  const terms = buildFixtureTerms(script.targetTerms);
  const websocketUrl = process.env.STT_COMPARE_WS_URL || `ws://127.0.0.1:${process.env.PORT || 8787}/ws`;
  const runDefinitions: Array<{ label: FixtureRunLabel; phraseSet: string[] }> = [
    { label: "without-phrase-set", phraseSet: [] },
    { label: "with-phrase-set", phraseSet: script.targetTerms }
  ];
  const runs: FixtureRunResult[] = [];

  for (const definition of runDefinitions) {
    console.log(`\n[${definition.label}] ${Math.round(recording.durationMs / 1_000)}초 음원을 Google STT에 재생합니다.`);
    const result = await runFixture({
      ...definition,
      websocketUrl,
      pcm,
      terms,
      targetTerms: script.targetTerms
    });
    runs.push(result);
    console.log(`[${definition.label}] ${result.status}: 확정 자막 ${result.finalTranscripts.length}개, 영문 기준 표기 일치 ${result.recognizedTerms.length}/${script.targetTerms.length}개`);
    if (result.errors.length) console.error(result.errors.join("\n"));
    await delay(1_000);
  }

  const baseline = runs[0];
  const adapted = runs[1];
  const report: ComparisonReport = {
    version: 2,
    createdAt: new Date().toISOString(),
    recordingId: recording.id,
    scriptId: script.id,
    scriptTitle: script.title,
    websocketUrl,
    targetTerms: script.targetTerms,
    measurementNote: "targetTerms는 비교 후보입니다. 발화자가 화면의 기준 문장을 그대로 읽었다고 확인된 경우에만 미일치 항목을 인식 실패로 계산합니다.",
    runs,
    comparison: script.targetTerms.map((term) => ({
      term,
      withoutPhraseSet: baseline.recognizedTerms.includes(term),
      withPhraseSet: adapted.recognizedTerms.includes(term)
    }))
  };
  const resultsRoot = path.join(fixtureRoot, "results");
  const outputPath = path.join(resultsRoot, `comparison-${recording.id}.json`);
  await mkdir(resultsRoot, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  console.table(report.comparison);
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

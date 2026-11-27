import "dotenv/config";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { inspectCanonicalWav, FIXTURE_WAV_HEADER_BYTES } from "../services/audio-fixtures.js";
import { resolveAwsRegion, type AwsPartialResultsStability } from "../services/aws-config.js";
import { createAwsTranscribeSession } from "../services/aws-transcribe.js";

const CONSENT = "I_UNDERSTAND_3_PAID_AWS_TRANSCRIBE_STREAMS";
const STABILITIES: AwsPartialResultsStability[] = ["off", "low", "medium"];

export function editDistance<T>(left: T[], right: T[]): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = left[leftIndex - 1] === right[rightIndex - 1]
        ? previous[rightIndex - 1]!
        : 1 + Math.min(previous[rightIndex]!, current[rightIndex - 1]!, previous[rightIndex - 1]!);
    }
    previous = current;
  }
  return previous[right.length]!;
}

export function errorRate(reference: string[], hypothesis: string[]): number {
  return reference.length === 0 ? (hypothesis.length === 0 ? 0 : 1) : editDistance(reference, hypothesis) / reference.length;
}

function characters(value: string): string[] {
  return [...value.replace(/\s+/gu, "")];
}

function words(value: string): string[] {
  return value.trim().split(/\s+/gu).filter(Boolean);
}

async function runOne(
  pcm: Buffer,
  reference: string,
  stability: AwsPartialResultsStability,
  vocabularyName?: string
) {
  const startedAt = performance.now();
  let firstPartialMs: number | null = null;
  let firstFinalMs: number | null = null;
  let partialUpdates = 0;
  let churnCharacters = 0;
  let previousPartial = "";
  const finalSegments: string[] = [];
  let releaseDrain: (() => void) | null = null;

  const terminal = new Promise<void>((resolve, reject) => {
    const session = createAwsTranscribeSession(vocabularyName, {
      onProviderAccepted: () => undefined,
      onTranscript: (emission) => {
        const elapsed = Math.round(performance.now() - startedAt);
        if (emission.isFinal) {
          firstFinalMs ??= elapsed;
          finalSegments.push(emission.text);
          previousPartial = "";
        } else {
          firstPartialMs ??= elapsed;
          partialUpdates += 1;
          churnCharacters += editDistance([...previousPartial], [...emission.text]);
          previousPartial = emission.text;
        }
      },
      onDrain: () => releaseDrain?.(),
      onError: reject,
      onEnd: () => resolve()
    }, {
      configuration: {
        region: resolveAwsRegion(),
        partialResultsStability: stability,
        providerTimeoutMs: 8_000,
        drainTimeoutMs: 8_000
      }
    });

    void (async () => {
      for (let offset = 0; offset < pcm.length; offset += 3_200) {
        const result = session.enqueueAudio(pcm.subarray(offset, Math.min(offset + 3_200, pcm.length)));
        if (result === "closed") throw new Error(`${stability} audio queue closed`);
        if (result === "backpressure") {
          await new Promise<void>((drained) => {
            releaseDrain = drained;
          });
          releaseDrain = null;
        }
        await delay(100);
      }
      session.finishInput();
    })().catch((error) => {
      session.abort(error instanceof Error ? error : new Error(String(error)));
      reject(error);
    });
  });
  await terminal;
  const hypothesis = finalSegments.join(" ").trim();
  return {
    stability,
    firstPartialMs,
    firstFinalMs,
    partialUpdates,
    churnCharacters,
    cer: errorRate(characters(reference), characters(hypothesis)),
    wer: errorRate(words(reference), words(hypothesis))
  };
}

async function main(): Promise<void> {
  const [wavPath, referencePath, consent, vocabularyName] = process.argv.slice(2);
  if (!wavPath || !referencePath || consent !== CONSENT) {
    throw new Error(`사용법: pnpm aws:stt:compare -- <16k-mono-pcm.wav> <reference.txt> ${CONSENT} [vocabularyName]`);
  }
  const [wav, reference] = await Promise.all([readFile(path.resolve(wavPath)), readFile(path.resolve(referencePath), "utf8")]);
  const info = inspectCanonicalWav(wav);
  const pcm = wav.subarray(FIXTURE_WAV_HEADER_BYTES, FIXTURE_WAV_HEADER_BYTES + info.dataBytes);
  console.log(`AWS region=${resolveAwsRegion()}, streams=3, stability=${STABILITIES.join("/")}, vocabulary=${vocabularyName || "none"}`);
  const runs = await Promise.all(STABILITIES.map((stability) => runOne(pcm, reference, stability, vocabularyName)));
  console.table(runs);

  const resultDirectory = path.resolve("test-fixtures/stt/results");
  await mkdir(resultDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const outputPath = path.join(resultDirectory, `aws-stability-${timestamp}.json`);
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify({ version: 1, createdAt: new Date().toISOString(), region: resolveAwsRegion(), runs }, null, 2)}\n`, { flag: "wx" });
  await rename(temporaryPath, outputPath);
  console.log(`결과 저장: ${outputPath}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

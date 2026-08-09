import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { parseFixtureScripts, type FixtureScript } from "./stt-comparison.js";

export const FIXTURE_SAMPLE_RATE = 16_000;
export const FIXTURE_CHANNELS = 1;
export const FIXTURE_BITS_PER_SAMPLE = 16;
export const FIXTURE_BYTES_PER_SECOND = FIXTURE_SAMPLE_RATE * FIXTURE_CHANNELS * (FIXTURE_BITS_PER_SAMPLE / 8);
export const FIXTURE_MAX_DURATION_MS = 120_000;
export const FIXTURE_WAV_HEADER_BYTES = 44;
export const FIXTURE_MAX_WAV_BYTES = FIXTURE_WAV_HEADER_BYTES + FIXTURE_BYTES_PER_SECOND * (FIXTURE_MAX_DURATION_MS / 1_000);
export const SPEECH_AUDIO_CHUNK_LIMIT = 15_000;
const WRITER_LOCK_WAIT_MS = 2_000;
const WRITER_LOCK_STALE_MS = 60_000;

const safeIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const fixtureFileNameSchema = z.string().regex(/^\d{14}-[0-9a-f]{8}-[0-9a-f-]{27}\.wav$/);

export const fixtureSpeakerLabelSchema = z.enum(["speaker-a", "speaker-b"]);
export const fixtureEnvironmentSchema = z.enum(["quiet", "noisy"]);

const fixtureRecordingFields = {
  id: z.string().uuid(),
  fileName: fixtureFileNameSchema,
  relativePath: z.string().regex(/^audio\/\d{14}-[0-9a-f]{8}-[0-9a-f-]{27}\.wav$/),
  scriptId: safeIdSchema,
  speakerLabel: fixtureSpeakerLabelSchema,
  environment: fixtureEnvironmentSchema,
  createdAt: z.string().datetime({ offset: true }),
  durationMs: z.number().int().positive().max(FIXTURE_MAX_DURATION_MS),
  sampleRate: z.literal(FIXTURE_SAMPLE_RATE),
  channels: z.literal(FIXTURE_CHANNELS),
  bitsPerSample: z.literal(FIXTURE_BITS_PER_SAMPLE),
  dataBytes: z.number().int().positive().max(FIXTURE_MAX_WAV_BYTES - FIXTURE_WAV_HEADER_BYTES).refine((value) => value % 2 === 0)
};

export const fixtureRecordingSchema = z.object({
  ...fixtureRecordingFields,
  speakerReadReferenceScriptVerbatim: z.boolean()
}).strict();

const legacyFixtureRecordingSchema = z.object(fixtureRecordingFields).strict();

export const fixtureManifestSchema = z.object({
  version: z.literal(2),
  recordings: z.array(fixtureRecordingSchema).max(1_000)
}).strict();

const legacyFixtureManifestSchema = z.object({
  version: z.literal(1),
  recordings: z.array(legacyFixtureRecordingSchema).max(1_000)
}).strict();

export type { FixtureScript } from "./stt-comparison.js";
export type FixtureSpeakerLabel = z.infer<typeof fixtureSpeakerLabelSchema>;
export type FixtureEnvironment = z.infer<typeof fixtureEnvironmentSchema>;
export type FixtureRecording = z.infer<typeof fixtureRecordingSchema>;
export type FixtureManifest = z.infer<typeof fixtureManifestSchema>;

export type AudioFixtureCatalog = {
  scripts: FixtureScript[];
  recordings: FixtureRecording[];
  storageDirectory: "test-fixtures/stt/audio";
};

export type SaveAudioFixtureInput = {
  scriptId: string;
  speakerLabel: string;
  environment: string;
  speakerReadReferenceScriptVerbatim?: boolean;
  wav: Buffer;
};

export type CanonicalWavInfo = {
  dataOffset: 44;
  dataBytes: number;
  durationMs: number;
};

export class AudioFixtureError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = "AudioFixtureError";
  }
}

function readAscii(buffer: Buffer, start: number, end: number): string {
  return buffer.toString("ascii", start, end);
}

export function inspectCanonicalWav(buffer: Buffer): CanonicalWavInfo {
  if (buffer.length < FIXTURE_WAV_HEADER_BYTES) throw new AudioFixtureError("WAV 헤더가 없거나 너무 짧습니다.");
  if (buffer.length > FIXTURE_MAX_WAV_BYTES) throw new AudioFixtureError("녹음은 최대 120초까지 저장할 수 있습니다.", 413);
  if (readAscii(buffer, 0, 4) !== "RIFF" || readAscii(buffer, 8, 12) !== "WAVE") {
    throw new AudioFixtureError("RIFF/WAVE 형식의 파일만 저장할 수 있습니다.");
  }
  if (buffer.readUInt32LE(4) + 8 !== buffer.length) throw new AudioFixtureError("RIFF 파일 크기가 실제 데이터와 일치하지 않습니다.");
  if (readAscii(buffer, 12, 16) !== "fmt " || buffer.readUInt32LE(16) !== 16) {
    throw new AudioFixtureError("canonical PCM WAV의 fmt 청크만 지원합니다.");
  }
  if (buffer.readUInt16LE(20) !== 1) throw new AudioFixtureError("PCM 형식 코드 1인 WAV만 지원합니다.");
  if (buffer.readUInt16LE(22) !== FIXTURE_CHANNELS) throw new AudioFixtureError("모노 WAV만 저장할 수 있습니다.");
  if (buffer.readUInt32LE(24) !== FIXTURE_SAMPLE_RATE) throw new AudioFixtureError("16kHz WAV만 저장할 수 있습니다.");
  if (buffer.readUInt32LE(28) !== FIXTURE_BYTES_PER_SECOND) throw new AudioFixtureError("WAV byteRate가 32000이어야 합니다.");
  if (buffer.readUInt16LE(32) !== 2) throw new AudioFixtureError("WAV blockAlign이 2여야 합니다.");
  if (buffer.readUInt16LE(34) !== FIXTURE_BITS_PER_SAMPLE) throw new AudioFixtureError("16-bit PCM WAV만 저장할 수 있습니다.");
  if (readAscii(buffer, 36, 40) !== "data") throw new AudioFixtureError("canonical WAV의 data 청크가 필요합니다.");

  const dataBytes = buffer.readUInt32LE(40);
  if (dataBytes <= 0) throw new AudioFixtureError("비어 있는 음성은 저장할 수 없습니다.");
  if (dataBytes % 2 !== 0) throw new AudioFixtureError("16-bit PCM 데이터 길이는 짝수여야 합니다.");
  if (FIXTURE_WAV_HEADER_BYTES + dataBytes !== buffer.length) {
    throw new AudioFixtureError("WAV data 크기 또는 파일 끝 위치가 올바르지 않습니다.");
  }

  const durationMs = Math.ceil((dataBytes / FIXTURE_BYTES_PER_SECOND) * 1_000);
  if (durationMs > FIXTURE_MAX_DURATION_MS) throw new AudioFixtureError("녹음은 최대 120초까지 저장할 수 있습니다.", 413);
  return { dataOffset: FIXTURE_WAV_HEADER_BYTES, dataBytes, durationMs };
}

export function splitPcmForSpeech(pcm: Buffer, requestedChunkBytes = SPEECH_AUDIO_CHUNK_LIMIT): Buffer[] {
  if (pcm.length === 0 || pcm.length % 2 !== 0) throw new AudioFixtureError("PCM 데이터는 비어 있지 않은 짝수 바이트여야 합니다.");
  if (!Number.isInteger(requestedChunkBytes) || requestedChunkBytes < 2) throw new AudioFixtureError("오디오 청크 크기가 올바르지 않습니다.");
  const chunkBytes = Math.min(requestedChunkBytes, SPEECH_AUDIO_CHUNK_LIMIT);
  const evenChunkBytes = chunkBytes - (chunkBytes % 2);
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < pcm.length; offset += evenChunkBytes) {
    chunks.push(pcm.subarray(offset, Math.min(offset + evenChunkBytes, pcm.length)));
  }
  return chunks;
}

type StoreDependencies = {
  now?: () => Date;
  randomId?: () => string;
  commitManifest?: (manifestPath: string, manifest: FixtureManifest) => Promise<void>;
};

function fixtureTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "").slice(0, 14);
}

async function assertSafeDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new AudioFixtureError("fixture 저장 경로가 안전한 디렉터리가 아닙니다.", 500);
}

async function assertSafeRegularFile(filePath: string): Promise<void> {
  const stats = await lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new AudioFixtureError("fixture 파일이 안전한 일반 파일이 아닙니다.", 500);
}

async function readJsonFile(filePath: string): Promise<unknown> {
  await assertSafeRegularFile(filePath);
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

async function defaultCommitManifest(manifestPath: string, manifest: FixtureManifest): Promise<void> {
  const temporaryPath = `${manifestPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await assertSafeRegularFile(temporaryPath);
    await rename(temporaryPath, manifestPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export class AudioFixtureStore {
  private queue: Promise<void> = Promise.resolve();
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly commitManifest: (manifestPath: string, manifest: FixtureManifest) => Promise<void>;

  constructor(
    private readonly root: string,
    dependencies: StoreDependencies = {}
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.randomId = dependencies.randomId ?? randomUUID;
    this.commitManifest = dependencies.commitManifest ?? defaultCommitManifest;
  }

  private get audioRoot(): string {
    return path.join(this.root, "audio");
  }

  private get scriptsPath(): string {
    return path.join(this.root, "scripts.json");
  }

  private get manifestPath(): string {
    return path.join(this.root, "manifest.local.json");
  }

  private get writerLockPath(): string {
    return path.join(this.root, ".writer.lock");
  }

  private async ensureLayout(): Promise<void> {
    await assertSafeDirectory(this.root);
    await assertSafeDirectory(this.audioRoot);
  }

  private async readScripts(): Promise<FixtureScript[]> {
    try {
      return parseFixtureScripts(await readJsonFile(this.scriptsPath)).scripts;
    } catch (error) {
      if (error instanceof AudioFixtureError) throw error;
      throw new AudioFixtureError("고정 실험 문장 파일이 없거나 형식이 올바르지 않습니다.", 500);
    }
  }

  private async readManifest(): Promise<FixtureManifest> {
    try {
      const value = await readJsonFile(this.manifestPath);
      const current = fixtureManifestSchema.safeParse(value);
      if (current.success) return current.data;
      const legacy = legacyFixtureManifestSchema.parse(value);
      return fixtureManifestSchema.parse({
        version: 2,
        recordings: legacy.recordings.map((recording) => ({
          ...recording,
          speakerReadReferenceScriptVerbatim: false
        }))
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 2, recordings: [] };
      if (error instanceof AudioFixtureError) throw error;
      throw new AudioFixtureError("로컬 fixture manifest가 손상되었습니다. 파일을 확인하거나 삭제해 주세요.", 500);
    }
  }

  async getCatalog(): Promise<AudioFixtureCatalog> {
    await this.queue;
    await this.ensureLayout();
    const [scripts, manifest] = await Promise.all([this.readScripts(), this.readManifest()]);
    return { scripts, recordings: manifest.recordings, storageDirectory: "test-fixtures/stt/audio" };
  }

  save(input: SaveAudioFixtureInput): Promise<FixtureRecording> {
    const operation = this.queue.then(() => this.saveNow(input));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async saveNow(input: SaveAudioFixtureInput): Promise<FixtureRecording> {
    await this.ensureLayout();
    const releaseLock = await this.acquireWriterLock();
    try {
      return await this.saveLocked(input);
    } finally {
      await releaseLock();
    }
  }

  private async acquireWriterLock(): Promise<() => Promise<void>> {
    const token = randomUUID();
    const deadline = Date.now() + WRITER_LOCK_WAIT_MS;
    while (true) {
      try {
        const handle = await open(this.writerLockPath, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }));
          await handle.close();
        } catch (error) {
          await handle.close().catch(() => undefined);
          await unlink(this.writerLockPath).catch(() => undefined);
          throw error;
        }
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          try {
            const lock = JSON.parse(await readFile(this.writerLockPath, "utf8")) as { token?: unknown };
            if (lock.token === token) await unlink(this.writerLockPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stats = await lstat(this.writerLockPath).catch((caught) => {
          if ((caught as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw caught;
        });
        if (!stats) continue;
        if (!stats.isFile() || stats.isSymbolicLink()) throw new AudioFixtureError("fixture writer lock이 안전한 일반 파일이 아닙니다.", 500);
        if (Date.now() - stats.mtimeMs > WRITER_LOCK_STALE_MS) {
          await unlink(this.writerLockPath).catch((caught) => {
            if ((caught as NodeJS.ErrnoException).code !== "ENOENT") throw caught;
          });
          continue;
        }
        if (Date.now() >= deadline) throw new AudioFixtureError("다른 개발 서버가 로컬 녹음 fixture를 저장 중입니다. 잠시 후 다시 시도해 주세요.", 409);
        await delay(25);
      }
    }
  }

  private async saveLocked(input: SaveAudioFixtureInput): Promise<FixtureRecording> {
    const [scripts, manifest] = await Promise.all([this.readScripts(), this.readManifest()]);
    const scriptId = safeIdSchema.parse(input.scriptId);
    const speakerLabel = fixtureSpeakerLabelSchema.parse(input.speakerLabel);
    const environment = fixtureEnvironmentSchema.parse(input.environment);
    if (!scripts.some((script) => script.id === scriptId)) throw new AudioFixtureError("선택한 고정 실험 문장을 찾을 수 없습니다.");

    const inspected = inspectCanonicalWav(input.wav);
    if (manifest.recordings.length >= 1_000) throw new AudioFixtureError("로컬 녹음 fixture가 1,000개에 도달했습니다. 기존 파일을 정리해 주세요.", 409);
    const id = z.string().uuid().parse(this.randomId());
    const createdAt = this.now().toISOString();
    const fileName = `${fixtureTimestamp(new Date(createdAt))}-${id}.wav`;
    const relativePath = `audio/${fileName}` as const;
    const recording = fixtureRecordingSchema.parse({
      id,
      fileName,
      relativePath,
      scriptId,
      speakerLabel,
      environment,
      createdAt,
      durationMs: inspected.durationMs,
      sampleRate: FIXTURE_SAMPLE_RATE,
      channels: FIXTURE_CHANNELS,
      bitsPerSample: FIXTURE_BITS_PER_SAMPLE,
      dataBytes: inspected.dataBytes,
      speakerReadReferenceScriptVerbatim: input.speakerReadReferenceScriptVerbatim ?? false
    });

    const finalPath = path.join(this.audioRoot, fileName);
    const temporaryPath = path.join(this.audioRoot, `.${fileName}.tmp-${process.pid}-${randomUUID()}`);
    let finalCreated = false;
    try {
      await writeFile(temporaryPath, input.wav, { flag: "wx", mode: 0o600 });
      await assertSafeRegularFile(temporaryPath);
      inspectCanonicalWav(await readFile(temporaryPath));
      await rename(temporaryPath, finalPath);
      finalCreated = true;
      const nextManifest = fixtureManifestSchema.parse({
        version: 2,
        recordings: [...manifest.recordings, recording]
      });
      await this.commitManifest(this.manifestPath, nextManifest);
      return recording;
    } catch (error) {
      if (finalCreated) await unlink(finalPath).catch(() => undefined);
      throw error;
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async loadPcm(recordingId: string): Promise<{ recording: FixtureRecording; pcm: Buffer }> {
    await this.queue;
    await this.ensureLayout();
    const id = z.string().uuid().parse(recordingId);
    const manifest = await this.readManifest();
    const recording = manifest.recordings.find((candidate) => candidate.id === id);
    if (!recording) throw new AudioFixtureError("저장된 녹음 fixture를 찾을 수 없습니다.", 404);

    const resolvedPath = path.resolve(this.root, recording.relativePath);
    if (path.dirname(resolvedPath) !== path.resolve(this.audioRoot)) throw new AudioFixtureError("fixture 경로가 저장 범위를 벗어났습니다.", 500);
    await assertSafeRegularFile(resolvedPath);
    const wav = await readFile(resolvedPath);
    const inspected = inspectCanonicalWav(wav);
    if (inspected.dataBytes !== recording.dataBytes || inspected.durationMs !== recording.durationMs) {
      throw new AudioFixtureError("WAV 파일과 manifest 메타데이터가 일치하지 않습니다.", 500);
    }
    return { recording, pcm: wav.subarray(inspected.dataOffset) };
  }
}

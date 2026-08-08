import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AudioFixtureStore,
  FIXTURE_BYTES_PER_SECOND,
  FIXTURE_MAX_DURATION_MS,
  inspectCanonicalWav,
  splitPcmForSpeech,
  type FixtureManifest
} from "./audio-fixtures.js";

const temporaryRoots: string[] = [];

function canonicalWav(dataBytes: number): Buffer {
  const buffer = Buffer.alloc(44 + dataBytes, 0);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24);
  buffer.writeUInt32LE(32_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 44; index < buffer.length; index += 1) buffer[index] = index % 251;
  return buffer;
}

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "lecture-audio-fixture-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "audio"));
  await writeFile(path.join(root, "scripts.json"), JSON.stringify({
    version: 1,
    scripts: [{
      id: "baseline-v1",
      title: "기준 문장",
      languageCode: "ko-KR",
      text: "RAG와 Transformer를 설명합니다.",
      targetTerms: ["RAG", "Transformer"]
    }]
  }));
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("canonical WAV validation", () => {
  it("accepts only the exact PCM1/mono/16kHz/16-bit canonical layout", () => {
    const wav = canonicalWav(32_000);
    expect(inspectCanonicalWav(wav)).toEqual({ dataOffset: 44, dataBytes: 32_000, durationMs: 1_000 });

    const mutations: Array<[string, (copy: Buffer) => void]> = [
      ["RIFF", (copy) => copy.write("NOPE", 0)],
      ["RIFF size", (copy) => copy.writeUInt32LE(1, 4)],
      ["fmt", (copy) => copy.write("JUNK", 12)],
      ["PCM1", (copy) => copy.writeUInt16LE(3, 20)],
      ["mono", (copy) => copy.writeUInt16LE(2, 22)],
      ["16000", (copy) => copy.writeUInt32LE(48_000, 24)],
      ["byteRate", (copy) => copy.writeUInt32LE(64_000, 28)],
      ["blockAlign", (copy) => copy.writeUInt16LE(4, 32)],
      ["16bit", (copy) => copy.writeUInt16LE(8, 34)],
      ["data", (copy) => copy.write("JUNK", 36)],
      ["data size", (copy) => copy.writeUInt32LE(2, 40)]
    ];
    for (const [name, mutate] of mutations) {
      const copy = Buffer.from(wav);
      mutate(copy);
      expect(() => inspectCanonicalWav(copy), name).toThrow();
    }
  });

  it("rejects empty, odd, trailing, and over-120-second data", () => {
    expect(() => inspectCanonicalWav(canonicalWav(0))).toThrow("비어 있는");
    expect(() => inspectCanonicalWav(canonicalWav(1))).toThrow("짝수");
    const trailing = Buffer.concat([canonicalWav(2), Buffer.from([0, 0])]);
    trailing.writeUInt32LE(trailing.length - 8, 4);
    expect(() => inspectCanonicalWav(trailing)).toThrow("파일 끝 위치");
    expect(inspectCanonicalWav(canonicalWav(FIXTURE_BYTES_PER_SECOND * (FIXTURE_MAX_DURATION_MS / 1_000))).durationMs).toBe(120_000);
    expect(() => inspectCanonicalWav(canonicalWav(FIXTURE_BYTES_PER_SECOND * 120 + 2))).toThrow("120초");
  });
});

describe("audio fixture store", () => {
  it("saves canonical WAV, records relative metadata, and reloads byte-identical PCM chunks", async () => {
    const root = await createFixtureRoot();
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const store = new AudioFixtureStore(root, {
      now: () => new Date("2026-08-09T12:34:56.000Z"),
      randomId: () => id
    });
    const wav = canonicalWav(30_002);

    const recording = await store.save({
      scriptId: "baseline-v1",
      speakerLabel: "speaker-a",
      environment: "quiet",
      wav
    });
    const loaded = await store.loadPcm(recording.id);
    const chunks = splitPcmForSpeech(loaded.pcm);

    expect(recording.relativePath).toBe(`audio/${recording.fileName}`);
    expect(recording.fileName).not.toContain("speaker-a");
    expect(chunks.every((chunk) => chunk.length <= 15_000 && chunk.length % 2 === 0)).toBe(true);
    expect(Buffer.concat(chunks)).toEqual(wav.subarray(44));
    expect(JSON.parse(await readFile(path.join(root, "manifest.local.json"), "utf8"))).toEqual({ version: 1, recordings: [recording] });
  });

  it("rolls back a renamed WAV after manifest failure and recovers the queue for the next save", async () => {
    const root = await createFixtureRoot();
    let commitCalls = 0;
    const ids = [
      "123e4567-e89b-42d3-a456-426614174001",
      "123e4567-e89b-42d3-a456-426614174002"
    ];
    const store = new AudioFixtureStore(root, {
      randomId: () => ids.shift()!,
      commitManifest: async (manifestPath: string, manifest: FixtureManifest) => {
        commitCalls += 1;
        if (commitCalls === 1) throw new Error("simulated manifest failure");
        await writeFile(manifestPath, JSON.stringify(manifest));
      }
    });
    const input = { scriptId: "baseline-v1", speakerLabel: "speaker-a", environment: "quiet", wav: canonicalWav(4) };

    await expect(store.save(input)).rejects.toThrow("simulated manifest failure");
    expect(await readdir(path.join(root, "audio"))).toEqual([]);

    const recovered = await store.save(input);
    expect(recovered.id).toBe("123e4567-e89b-42d3-a456-426614174002");
    expect((await readdir(path.join(root, "audio"))).filter((name) => name.endsWith(".wav"))).toHaveLength(1);
  });

  it("serializes two store instances sharing one fixture root without losing manifest entries", async () => {
    const root = await createFixtureRoot();
    let releaseFirstCommit!: () => void;
    let firstCommitStarted!: () => void;
    const firstCommit = new Promise<void>((resolve) => { firstCommitStarted = resolve; });
    const commitGate = new Promise<void>((resolve) => { releaseFirstCommit = resolve; });
    const first = new AudioFixtureStore(root, {
      randomId: () => "123e4567-e89b-42d3-a456-426614174010",
      commitManifest: async (manifestPath: string, manifest: FixtureManifest) => {
        firstCommitStarted();
        await commitGate;
        await writeFile(manifestPath, JSON.stringify(manifest));
      }
    });
    const second = new AudioFixtureStore(root, {
      randomId: () => "123e4567-e89b-42d3-a456-426614174011"
    });
    const input = { scriptId: "baseline-v1", speakerLabel: "speaker-a", environment: "quiet", wav: canonicalWav(4) };

    const firstSave = first.save(input);
    await firstCommit;
    const secondSave = second.save({ ...input, speakerLabel: "speaker-b" });
    await Promise.resolve();
    releaseFirstCommit();
    await Promise.all([firstSave, secondSave]);

    const catalog = await second.getCatalog();
    expect(catalog.recordings.map((recording) => recording.id)).toEqual([
      "123e4567-e89b-42d3-a456-426614174010",
      "123e4567-e89b-42d3-a456-426614174011"
    ]);
    expect((await readdir(path.join(root, "audio"))).filter((name) => name.endsWith(".wav"))).toHaveLength(2);
    await expect(readFile(path.join(root, ".writer.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked audio directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lecture-audio-symlink-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "lecture-audio-outside-"));
    temporaryRoots.push(root, outside);
    await writeFile(path.join(root, "scripts.json"), JSON.stringify({
      version: 1,
      scripts: [{ id: "baseline-v1", title: "기준", languageCode: "ko-KR", text: "기준", targetTerms: [] }]
    }));
    await symlink(outside, path.join(root, "audio"));

    await expect(new AudioFixtureStore(root).getCatalog()).rejects.toThrow("안전한 디렉터리");
  });
});

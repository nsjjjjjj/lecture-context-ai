import http, { type Server } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, isLocalFixtureRequest, resolveListenHost } from "./app.js";
import { FIXTURE_MAX_WAV_BYTES } from "./services/audio-fixtures.js";

const temporaryRoots: string[] = [];
const servers: Server[] = [];

function canonicalWav(dataBytes = 32): Buffer {
  const buffer = Buffer.alloc(44 + dataBytes, 1);
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
  return buffer;
}

async function listen(app: ReturnType<typeof createApp>): Promise<string> {
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("ephemeral test port unavailable");
  return `http://127.0.0.1:${address.port}`;
}

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "lecture-app-fixture-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "audio"));
  await writeFile(path.join(root, "scripts.json"), JSON.stringify({
    version: 1,
    scripts: [{ id: "baseline-v1", title: "기준 문장", languageCode: "ko-KR", text: "RAG", targetTerms: ["RAG"] }]
  }));
  return root;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("production API boundary", () => {
  it("returns JSON 404 for development fixture GET and POST before the SPA fallback", async () => {
    const clientDist = await mkdtemp(path.join(os.tmpdir(), "lecture-client-dist-"));
    temporaryRoots.push(clientDist);
    await writeFile(path.join(clientDist, "index.html"), "<html>SPA</html>");
    const baseUrl = await listen(createApp({ nodeEnv: "production", clientDist }));

    for (const request of [
      fetch(`${baseUrl}/api/dev/audio-fixtures`),
      fetch(`${baseUrl}/api/dev/audio-fixtures`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: canonicalWav() })
    ]) {
      const response = await request;
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({ error: "API 경로를 찾을 수 없습니다." });
    }
  });
});

describe("development audio fixture API", () => {
  it("serves scripts and saves a canonical local WAV with JSON responses", async () => {
    const fixtureRoot = await createFixtureRoot();
    const baseUrl = await listen(createApp({ nodeEnv: "development", fixtureRoot }));
    const catalogResponse = await fetch(`${baseUrl}/api/dev/audio-fixtures`);
    expect(catalogResponse.status).toBe(200);
    expect((await catalogResponse.json() as { scripts: unknown[] }).scripts).toHaveLength(1);

    const query = new URLSearchParams({ scriptId: "baseline-v1", speakerLabel: "speaker-a", environment: "quiet" });
    const saveResponse = await fetch(`${baseUrl}/api/dev/audio-fixtures?${query}`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav", Origin: baseUrl },
      body: canonicalWav()
    });
    expect(saveResponse.status).toBe(201);
    expect(saveResponse.headers.get("content-type")).toContain("application/json");
    expect((await saveResponse.json() as { recording: { relativePath: string } }).recording.relativePath).toMatch(/^audio\/.*\.wav$/);
  });

  it("rejects LAN origins, wrong content types, and invalid WAV as JSON", async () => {
    const fixtureRoot = await createFixtureRoot();
    const baseUrl = await listen(createApp({ nodeEnv: "development", fixtureRoot }));
    const query = new URLSearchParams({ scriptId: "baseline-v1", speakerLabel: "speaker-a", environment: "quiet" });
    const url = `${baseUrl}/api/dev/audio-fixtures?${query}`;

    const cases = [
      await fetch(url, { method: "POST", headers: { "Content-Type": "audio/wav", Origin: "http://192.168.0.22:5173" }, body: canonicalWav() }),
      await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: baseUrl }, body: canonicalWav() }),
      await fetch(url, { method: "POST", headers: { "Content-Type": "audio/wav", Origin: baseUrl }, body: Buffer.from("not wav") }),
      await fetch(url, { method: "POST", headers: { "Content-Type": "audio/wav", Origin: baseUrl }, body: Buffer.alloc(FIXTURE_MAX_WAV_BYTES + 1) })
    ];

    expect(cases.map((response) => response.status)).toEqual([403, 415, 400, 413]);
    for (const response of cases) {
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toHaveProperty("error");
    }
  });
});

describe("local request classification", () => {
  it("requires loopback socket, host, and origin when present", () => {
    expect(isLocalFixtureRequest({ remoteAddress: "::ffff:127.0.0.1", host: "localhost:5173", origin: "http://localhost:5173" })).toBe(true);
    expect(isLocalFixtureRequest({ remoteAddress: "192.168.0.10", host: "localhost:5173" })).toBe(false);
    expect(isLocalFixtureRequest({ remoteAddress: "127.0.0.1", host: "192.168.0.10:5173" })).toBe(false);
    expect(isLocalFixtureRequest({ remoteAddress: "127.0.0.1", host: "localhost:5173", origin: "http://192.168.0.10:5173" })).toBe(false);
  });

  it("binds development to loopback even when a broad host is configured", () => {
    expect(resolveListenHost("development", "0.0.0.0")).toBe("127.0.0.1");
    expect(resolveListenHost("production", undefined)).toBe("0.0.0.0");
    expect(resolveListenHost("production", "10.0.0.4")).toBe("10.0.0.4");
  });
});

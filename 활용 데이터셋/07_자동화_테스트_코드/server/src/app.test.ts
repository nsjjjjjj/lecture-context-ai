import http, { type Server } from "node:http";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createApp,
  isLocalFixtureRequest,
  resolveListenHost,
  type AppOptions
} from "./app.js";
import {
  AudioFixtureStore,
  FIXTURE_MAX_WAV_BYTES
} from "./services/audio-fixtures.js";
import type { SttComparisonJob } from "./services/stt-comparison-jobs.js";
import {
  STT_COMPARISON_LOCK_FILE,
  SttComparisonLockError,
  type SttComparisonLockRecord
} from "./services/stt-comparison-lock.js";

const temporaryRoots: string[] = [];
const servers: Server[] = [];
const RECORDING_ID = "123e4567-e89b-42d3-a456-426614174000";
const PAID_STT_CALL_CONSENT = "I_UNDERSTAND_3_PAID_GOOGLE_STT_CALLS";
const PUBLIC_JOB_KEYS = [
  "id",
  "recordingId",
  "status",
  "state",
  "createdAt",
  "startedAt",
  "updatedAt",
  "finishedAt",
  "completedAt",
  "progress",
  "activeRunLabel",
  "runs",
  "message",
  "fatalError",
  "resultFileName"
];

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

function comparisonJob(overrides: Partial<SttComparisonJob> = {}): SttComparisonJob {
  return {
    id: "local-job-1",
    recordingId: RECORDING_ID,
    status: "running",
    state: "running",
    createdAt: "2026-08-09T00:00:00.000Z",
    startedAt: "2026-08-09T00:00:01.000Z",
    updatedAt: "2026-08-09T00:00:02.000Z",
    finishedAt: null,
    completedAt: null,
    completedRuns: 1,
    totalRuns: 3,
    progress: { completed: 1, total: 3, percent: 50 },
    activeRun: { label: "canonical-phrase-set", index: 1, total: 3 },
    activeRunLabel: "canonical-phrase-set",
    replayProgress: { sentBytes: 1_600, totalBytes: 3_200, fraction: 0.5 },
    runs: [
      { label: "without-phrase-set", state: "completed", message: "실행 완료", error: null },
      { label: "canonical-phrase-set", state: "running", message: "고정 음원 재생 중", error: null },
      { label: "spoken-alias-phrase-set", state: "pending", message: null, error: null }
    ],
    resultPath: "/private/results/comparison-secret.json",
    resultFileName: null,
    runErrors: [{ label: "without-phrase-set", errors: ["internal run diagnostic"] }],
    message: "canonical-phrase-set 조건을 실행하고 있습니다.",
    error: "internal aggregate error",
    fatalError: null,
    ...overrides
  };
}

function fakeJobManager() {
  return {
    getCurrentJob: vi.fn((): SttComparisonJob | undefined => undefined),
    getJob: vi.fn((_jobId: string): SttComparisonJob | undefined => undefined),
    startJob: vi.fn((input: { recordingId: string }): SttComparisonJob => comparisonJob({
      id: "started-job",
      recordingId: input.recordingId,
      status: "starting",
      state: "starting",
      startedAt: null,
      progress: { completed: 0, total: 3, percent: 0 },
      activeRun: null,
      activeRunLabel: null,
      replayProgress: null,
      message: "STT 비교 작업을 시작합니다."
    }))
  };
}

function developmentOptions(fixtureRoot: string, overrides: Partial<AppOptions> = {}): AppOptions {
  return {
    nodeEnv: "development",
    fixtureRoot,
    jobManager: fakeJobManager(),
    getGoogleSpeechConfigurationError: () => null,
    readSttComparisonLock: async () => null,
    probeProcess: () => undefined,
    ...overrides
  };
}

async function createStoredRecording(fixtureRoot: string): Promise<void> {
  const store = new AudioFixtureStore(fixtureRoot, {
    randomId: () => RECORDING_ID,
    now: () => new Date("2026-08-09T00:00:00.000Z")
  });
  await store.save({
    scriptId: "baseline-v1",
    speakerLabel: "speaker-a",
    environment: "quiet",
    speakerReadReferenceScriptVerbatim: true,
    wav: canonicalWav()
  });
}

function lockRecord(overrides: Partial<SttComparisonLockRecord> = {}): SttComparisonLockRecord {
  return {
    ownerToken: "123e4567-e89b-42d3-a456-426614174001",
    pid: 4242,
    jobId: "external-job",
    owner: "cli",
    recordingId: RECORDING_ID,
    acquiredAt: "2026-08-09T00:00:00.000Z",
    ...overrides
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("production API boundary", () => {
  it("returns JSON 404 for development fixture APIs before the SPA fallback", async () => {
    const clientDist = await mkdtemp(path.join(os.tmpdir(), "lecture-client-dist-"));
    temporaryRoots.push(clientDist);
    await writeFile(path.join(clientDist, "index.html"), "<html>SPA</html>");
    const baseUrl = await listen(createApp({ nodeEnv: "production", clientDist }));

    for (const request of [
      fetch(`${baseUrl}/api/dev/audio-fixtures`),
      fetch(`${baseUrl}/api/dev/audio-fixtures`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: canonicalWav() }),
      fetch(`${baseUrl}/api/dev/stt-comparisons`),
      fetch(`${baseUrl}/api/dev/stt-comparisons/comparison-result.json`),
      fetch(`${baseUrl}/api/dev/stt-comparison-jobs/current`),
      fetch(`${baseUrl}/api/dev/stt-comparison-jobs/local-job`),
      fetch(`${baseUrl}/api/dev/stt-comparison-jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordingId: RECORDING_ID, paidCallConsent: PAID_STT_CALL_CONSENT })
      }),
      fetch(`${baseUrl}/api/dev/stt-comparison-jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{"
      })
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
    const baseUrl = await listen(createApp(developmentOptions(fixtureRoot)));
    const catalogResponse = await fetch(`${baseUrl}/api/dev/audio-fixtures`);
    expect(catalogResponse.status).toBe(200);
    expect((await catalogResponse.json() as { scripts: unknown[] }).scripts).toHaveLength(1);

    const query = new URLSearchParams({
      scriptId: "baseline-v1",
      speakerLabel: "speaker-a",
      environment: "quiet",
      speakerReadReferenceScriptVerbatim: "true"
    });
    const saveResponse = await fetch(`${baseUrl}/api/dev/audio-fixtures?${query}`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav", Origin: baseUrl },
      body: canonicalWav()
    });
    expect(saveResponse.status).toBe(201);
    expect(saveResponse.headers.get("content-type")).toContain("application/json");
    expect((await saveResponse.json() as { recording: { relativePath: string; speakerReadReferenceScriptVerbatim: boolean } }).recording).toMatchObject({
      relativePath: expect.stringMatching(/^audio\/.*\.wav$/),
      speakerReadReferenceScriptVerbatim: true
    });

    const compatibilityQuery = new URLSearchParams({ scriptId: "baseline-v1", speakerLabel: "speaker-b", environment: "noisy" });
    const compatibilityResponse = await fetch(`${baseUrl}/api/dev/audio-fixtures?${compatibilityQuery}`, {
      method: "POST",
      headers: { "Content-Type": "audio/x-wav", Origin: baseUrl },
      body: canonicalWav()
    });
    expect(compatibilityResponse.status).toBe(201);
    expect((await compatibilityResponse.json() as { recording: { speakerReadReferenceScriptVerbatim: boolean } }).recording)
      .toMatchObject({ speakerReadReferenceScriptVerbatim: false });
  });

  it("rejects LAN origins, wrong content types, and invalid WAV as JSON", async () => {
    const fixtureRoot = await createFixtureRoot();
    const baseUrl = await listen(createApp(developmentOptions(fixtureRoot)));
    const query = new URLSearchParams({ scriptId: "baseline-v1", speakerLabel: "speaker-a", environment: "quiet" });
    const url = `${baseUrl}/api/dev/audio-fixtures?${query}`;

    const cases = [
      await fetch(url, { method: "POST", headers: { "Content-Type": "audio/wav", Origin: "http://192.168.0.22:5173" }, body: canonicalWav() }),
      await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: baseUrl }, body: canonicalWav() }),
      await fetch(url, { method: "POST", headers: { "Content-Type": "audio/wav", Origin: baseUrl }, body: Buffer.from("not wav") }),
      await fetch(url, { method: "POST", headers: { "Content-Type": "audio/wav", Origin: baseUrl }, body: Buffer.alloc(FIXTURE_MAX_WAV_BYTES + 1) }),
      await fetch(`${url}&speakerReadReferenceScriptVerbatim=yes`, {
        method: "POST",
        headers: { "Content-Type": "audio/wav", Origin: baseUrl },
        body: canonicalWav()
      })
    ];

    expect(cases.map((response) => response.status)).toEqual([403, 415, 400, 413, 400]);
    for (const response of cases) {
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toHaveProperty("error");
    }
  });
});

describe("development STT comparison result API", () => {
  it("returns the expanded empty and legacy history response contracts", async () => {
    const fixtureRoot = await createFixtureRoot();
    const baseUrl = await listen(createApp(developmentOptions(fixtureRoot)));

    const emptyResponse = await fetch(`${baseUrl}/api/dev/stt-comparisons`);
    expect(emptyResponse.status).toBe(200);
    expect(await emptyResponse.json()).toEqual({
      latest: null,
      latestFileName: null,
      reportCount: 0,
      history: [],
      page: { offset: 0, limit: 25, hasMore: false }
    });

    await mkdir(path.join(fixtureRoot, "results"));
    await writeFile(path.join(fixtureRoot, "results/comparison-legacy.json"), JSON.stringify({
      version: 2,
      runs: [{ transcript: "complete legacy transcript" }]
    }));
    const legacyResponse = await fetch(`${baseUrl}/api/dev/stt-comparisons`);
    expect(legacyResponse.status).toBe(200);
    expect(await legacyResponse.json()).toMatchObject({
      reportCount: 1,
      latestFileName: "comparison-legacy.json",
      latest: { version: 2, runs: [{ transcript: "complete legacy transcript" }] },
      history: [{
        fileName: "comparison-legacy.json",
        version: 2,
        createdAt: null,
        recordingId: null,
        scriptTitle: null,
        evaluationMode: null,
        runOutcome: "legacy"
      }],
      page: { offset: 0, limit: 25, hasMore: false }
    });
  });

  it("rejects non-loopback origins with JSON 403", async () => {
    const fixtureRoot = await createFixtureRoot();
    const baseUrl = await listen(createApp(developmentOptions(fixtureRoot)));

    const response = await fetch(`${baseUrl}/api/dev/stt-comparisons`, {
      headers: { Origin: "http://192.168.0.22:5173" }
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toHaveProperty("error");
  });

  it("passes numeric offset/limit through and safely serves only validated detail files", async () => {
    const fixtureRoot = await createFixtureRoot();
    const resultsRoot = path.join(fixtureRoot, "results");
    await mkdir(resultsRoot);
    const olderPath = path.join(resultsRoot, "comparison-older.json");
    const newerPath = path.join(resultsRoot, "comparison-newer.json");
    await writeFile(olderPath, JSON.stringify({ version: 1, marker: "older" }));
    await writeFile(newerPath, JSON.stringify({ version: 2, marker: "newer" }));
    await utimes(olderPath, new Date("2026-08-09T00:00:00.000Z"), new Date("2026-08-09T00:00:00.000Z"));
    await utimes(newerPath, new Date("2026-08-09T00:01:00.000Z"), new Date("2026-08-09T00:01:00.000Z"));
    const baseUrl = await listen(createApp(developmentOptions(fixtureRoot)));

    const pageResponse = await fetch(`${baseUrl}/api/dev/stt-comparisons?offset=1&limit=1`);
    expect(pageResponse.status).toBe(200);
    expect(await pageResponse.json()).toMatchObject({
      latest: { version: 2, marker: "newer" },
      latestFileName: "comparison-newer.json",
      reportCount: 2,
      history: [{ fileName: "comparison-older.json", version: 1 }],
      page: { offset: 1, limit: 1, hasMore: false }
    });

    const detailResponse = await fetch(`${baseUrl}/api/dev/stt-comparisons/comparison-older.json`);
    expect(detailResponse.status).toBe(200);
    expect(await detailResponse.json()).toMatchObject({
      fileName: "comparison-older.json",
      modifiedAt: "2026-08-09T00:00:00.000Z",
      report: { version: 1, marker: "older" }
    });

    for (const unsafeName of ["not-a-comparison.json", "..%2Fscripts.json"]) {
      const response = await fetch(`${baseUrl}/api/dev/stt-comparisons/${unsafeName}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "RESULT_NOT_FOUND" });
    }
  });
});

describe("development STT comparison job reads", () => {
  it("returns local jobs first through the exact public mapper and never reads the lock", async () => {
    const fixtureRoot = await createFixtureRoot();
    const manager = fakeJobManager();
    const job = comparisonJob();
    manager.getCurrentJob.mockReturnValue(job);
    manager.getJob.mockImplementation((jobId) => jobId === job.id ? job : undefined);
    const readLock = vi.fn(async () => lockRecord());
    const baseUrl = await listen(createApp(developmentOptions(fixtureRoot, {
      jobManager: manager,
      readSttComparisonLock: readLock
    })));

    const currentResponse = await fetch(`${baseUrl}/api/dev/stt-comparison-jobs/current`);
    expect(currentResponse.status).toBe(200);
    const currentBody = await currentResponse.json() as { active: { kind: string; job: Record<string, unknown> } };
    expect(currentBody.active.kind).toBe("local");
    expect(Object.keys(currentBody.active.job)).toEqual(PUBLIC_JOB_KEYS);
    expect(currentBody.active.job).not.toHaveProperty("resultPath");
    expect(currentBody.active.job).not.toHaveProperty("replayProgress");
    expect(currentBody.active.job).not.toHaveProperty("runErrors");
    expect(readLock).not.toHaveBeenCalled();

    const detailResponse = await fetch(`${baseUrl}/api/dev/stt-comparison-jobs/${job.id}`);
    expect(detailResponse.status).toBe(200);
    const detailBody = await detailResponse.json() as { job: Record<string, unknown> };
    expect(Object.keys(detailBody.job)).toEqual(PUBLIC_JOB_KEYS);

    const missingResponse = await fetch(`${baseUrl}/api/dev/stt-comparison-jobs/missing-job`);
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toMatchObject({ code: "JOB_NOT_FOUND" });
  });

  it("redacts internal terminal job failures from mapped and serialized public output", async () => {
    const fixtureRoot = await createFixtureRoot();
    const manager = fakeJobManager();
    const rawFatalError = "runner raw-secret failed at /Users/internal-worker/private/comparison.lock";
    const job = comparisonJob({
      status: "failed",
      state: "failed",
      activeRun: null,
      activeRunLabel: null,
      replayProgress: null,
      finishedAt: "2026-08-09T00:00:03.000Z",
      completedAt: "2026-08-09T00:00:03.000Z",
      message: "STT 비교 작업을 완료하지 못했습니다.",
      error: rawFatalError,
      fatalError: rawFatalError
    });
    manager.getCurrentJob.mockReturnValue(job);
    const baseUrl = await listen(createApp(developmentOptions(fixtureRoot, { jobManager: manager })));

    const response = await fetch(`${baseUrl}/api/dev/stt-comparison-jobs/current`);
    expect(response.status).toBe(200);
    const serializedBody = await response.text();
    const body = JSON.parse(serializedBody) as {
      active: { kind: string; job: Record<string, unknown> };
    };

    expect(body.active.job.fatalError).toBe("STT 비교 작업을 완료하지 못했습니다.");
    expect(serializedBody).toContain("STT 비교 작업을 완료하지 못했습니다.");
    expect(serializedBody).not.toContain(rawFatalError);
    expect(serializedBody).not.toContain("/Users/internal-worker/private/comparison.lock");
    expect(serializedBody).not.toContain("raw-secret");
    expect(job.fatalError).toBe(rawFatalError);
  });

  it("reports live and EPERM-owned locks as redacted external jobs", async () => {
    for (const probeProcess of [
      vi.fn((_pid: number) => undefined),
      vi.fn((_pid: number) => { throw Object.assign(new Error("denied"), { code: "EPERM" }); })
    ]) {
      const fixtureRoot = await createFixtureRoot();
      const readLock = vi.fn(async () => lockRecord());
      const baseUrl = await listen(createApp(developmentOptions(fixtureRoot, {
        readSttComparisonLock: readLock,
        probeProcess
      })));

      const response = await fetch(`${baseUrl}/api/dev/stt-comparison-jobs/current`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        active: {
          kind: "external",
          job: {
            id: "external-job",
            owner: "cli",
            recordingId: RECORDING_ID,
            startedAt: "2026-08-09T00:00:00.000Z",
            state: "running"
          }
        }
      });
      expect(readLock).toHaveBeenCalledWith(path.join(fixtureRoot, STT_COMPARISON_LOCK_FILE));
      expect(probeProcess).toHaveBeenCalledWith(4242);
    }
  });

  it("treats ESRCH as inactive and fails closed with 409 for unsafe lock state", async () => {
    const staleRoot = await createFixtureRoot();
    const staleUrl = await listen(createApp(developmentOptions(staleRoot, {
      readSttComparisonLock: async () => lockRecord(),
      probeProcess: () => { throw Object.assign(new Error("missing"), { code: "ESRCH" }); }
    })));
    const staleResponse = await fetch(`${staleUrl}/api/dev/stt-comparison-jobs/current`);
    expect(staleResponse.status).toBe(200);
    expect(await staleResponse.json()).toEqual({ active: null });

    const unsafeRoot = await createFixtureRoot();
    const unsafeUrl = await listen(createApp(developmentOptions(unsafeRoot, {
      readSttComparisonLock: async () => {
        throw new SttComparisonLockError("unsafe", "UNSAFE");
      }
    })));
    const unsafeResponse = await fetch(`${unsafeUrl}/api/dev/stt-comparison-jobs/current`);
    expect(unsafeResponse.status).toBe(409);
    expect(await unsafeResponse.json()).toMatchObject({ code: "COMPARISON_LOCK_UNSAFE" });

    const unprobeableRoot = await createFixtureRoot();
    const unprobeableUrl = await listen(createApp(developmentOptions(unprobeableRoot, {
      readSttComparisonLock: async () => lockRecord(),
      probeProcess: () => { throw Object.assign(new Error("probe failed"), { code: "EIO" }); }
    })));
    const unprobeableResponse = await fetch(`${unprobeableUrl}/api/dev/stt-comparison-jobs/current`);
    expect(unprobeableResponse.status).toBe(409);
    expect(await unprobeableResponse.json()).toMatchObject({ code: "COMPARISON_LOCK_UNSAFE" });
  });
});

describe("development STT comparison job start", () => {
  it("validates a strict UUID before exact consent and performs no later checks", async () => {
    const fixtureRoot = await createFixtureRoot();
    const manager = fakeJobManager();
    const readLock = vi.fn(async () => null);
    const getConfigurationError = vi.fn(() => null);
    const baseUrl = await listen(createApp(developmentOptions(fixtureRoot, {
      jobManager: manager,
      readSttComparisonLock: readLock,
      getGoogleSpeechConfigurationError: getConfigurationError
    })));

    const malformedJson = await fetch(`${baseUrl}/api/dev/stt-comparison-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{"
    });
    expect(malformedJson.status).toBe(400);
    expect(await malformedJson.json()).toMatchObject({ code: "INVALID_REQUEST" });

    const invalidRequest = await fetch(`${baseUrl}/api/dev/stt-comparison-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recordingId: "not-a-uuid", paidCallConsent: "wrong", extra: true })
    });
    expect(invalidRequest.status).toBe(400);
    expect(await invalidRequest.json()).toMatchObject({ code: "INVALID_REQUEST" });

    const missingConsent = await fetch(`${baseUrl}/api/dev/stt-comparison-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recordingId: RECORDING_ID })
    });
    expect(missingConsent.status).toBe(400);
    expect(await missingConsent.json()).toMatchObject({ code: "CONSENT_REQUIRED" });
    expect(manager.getCurrentJob).not.toHaveBeenCalled();
    expect(readLock).not.toHaveBeenCalled();
    expect(getConfigurationError).not.toHaveBeenCalled();
    expect(manager.startJob).not.toHaveBeenCalled();
  });

  it("rejects a local or live external job as busy before configuration checks", async () => {
    const localRoot = await createFixtureRoot();
    const localManager = fakeJobManager();
    localManager.getCurrentJob.mockReturnValue(comparisonJob());
    const localReadLock = vi.fn(async () => null);
    const localConfig = vi.fn(() => "not configured");
    const localUrl = await listen(createApp(developmentOptions(localRoot, {
      jobManager: localManager,
      readSttComparisonLock: localReadLock,
      getGoogleSpeechConfigurationError: localConfig
    })));
    const localResponse = await fetch(`${localUrl}/api/dev/stt-comparison-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recordingId: RECORDING_ID, paidCallConsent: PAID_STT_CALL_CONSENT })
    });
    expect(localResponse.status).toBe(409);
    expect(await localResponse.json()).toMatchObject({ code: "COMPARISON_BUSY" });
    expect(localReadLock).not.toHaveBeenCalled();
    expect(localConfig).not.toHaveBeenCalled();

    const externalRoot = await createFixtureRoot();
    const externalConfig = vi.fn(() => "not configured");
    const externalUrl = await listen(createApp(developmentOptions(externalRoot, {
      readSttComparisonLock: async () => lockRecord(),
      probeProcess: () => undefined,
      getGoogleSpeechConfigurationError: externalConfig
    })));
    const externalResponse = await fetch(`${externalUrl}/api/dev/stt-comparison-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recordingId: RECORDING_ID, paidCallConsent: PAID_STT_CALL_CONSENT })
    });
    expect(externalResponse.status).toBe(409);
    expect(await externalResponse.json()).toMatchObject({ code: "COMPARISON_BUSY" });
    expect(externalConfig).not.toHaveBeenCalled();
  });

  it("orders unsafe lock, STT configuration, and recording existence failures", async () => {
    const unsafeRoot = await createFixtureRoot();
    const unsafeConfig = vi.fn(() => "not configured");
    const unsafeUrl = await listen(createApp(developmentOptions(unsafeRoot, {
      readSttComparisonLock: async () => {
        throw new SttComparisonLockError("malformed", "MALFORMED");
      },
      getGoogleSpeechConfigurationError: unsafeConfig
    })));
    const unsafeResponse = await fetch(`${unsafeUrl}/api/dev/stt-comparison-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recordingId: RECORDING_ID, paidCallConsent: PAID_STT_CALL_CONSENT })
    });
    expect(unsafeResponse.status).toBe(409);
    expect(await unsafeResponse.json()).toMatchObject({ code: "COMPARISON_LOCK_UNSAFE" });
    expect(unsafeConfig).not.toHaveBeenCalled();

    const configRoot = await createFixtureRoot();
    const configUrl = await listen(createApp(developmentOptions(configRoot, {
      getGoogleSpeechConfigurationError: () => "GOOGLE_CLOUD_PROJECT가 설정되지 않았습니다."
    })));
    const configResponse = await fetch(`${configUrl}/api/dev/stt-comparison-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recordingId: RECORDING_ID, paidCallConsent: PAID_STT_CALL_CONSENT })
    });
    expect(configResponse.status).toBe(503);
    expect(await configResponse.json()).toMatchObject({ code: "STT_NOT_CONFIGURED" });

    const missingRoot = await createFixtureRoot();
    const missingUrl = await listen(createApp(developmentOptions(missingRoot)));
    const missingResponse = await fetch(`${missingUrl}/api/dev/stt-comparison-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recordingId: RECORDING_ID, paidCallConsent: PAID_STT_CALL_CONSENT })
    });
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toMatchObject({ code: "RECORDING_NOT_FOUND" });
  });

  it("rechecks local activity immediately before starting and returns the mapped 202 job", async () => {
    const racedRoot = await createFixtureRoot();
    await createStoredRecording(racedRoot);
    const racedManager = fakeJobManager();
    racedManager.getCurrentJob
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(comparisonJob({ id: "racing-job" }));
    const racedUrl = await listen(createApp(developmentOptions(racedRoot, { jobManager: racedManager })));
    const racedResponse = await fetch(`${racedUrl}/api/dev/stt-comparison-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recordingId: RECORDING_ID, paidCallConsent: PAID_STT_CALL_CONSENT })
    });
    expect(racedResponse.status).toBe(409);
    expect(await racedResponse.json()).toMatchObject({ code: "COMPARISON_BUSY" });
    expect(racedManager.getCurrentJob).toHaveBeenCalledTimes(2);
    expect(racedManager.startJob).not.toHaveBeenCalled();

    const startedRoot = await createFixtureRoot();
    await createStoredRecording(startedRoot);
    const startedManager = fakeJobManager();
    const probeProcess = vi.fn((_pid: number) => {
      throw Object.assign(new Error("missing"), { code: "ESRCH" });
    });
    const startedUrl = await listen(createApp(developmentOptions(startedRoot, {
      jobManager: startedManager,
      websocketUrl: "ws://127.0.0.1:9999/ws",
      readSttComparisonLock: async () => lockRecord(),
      probeProcess
    })));
    const startedResponse = await fetch(`${startedUrl}/api/dev/stt-comparison-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recordingId: RECORDING_ID, paidCallConsent: PAID_STT_CALL_CONSENT })
    });
    expect(startedResponse.status).toBe(202);
    const startedBody = await startedResponse.json() as { job: Record<string, unknown> };
    expect(Object.keys(startedBody.job)).toEqual(PUBLIC_JOB_KEYS);
    expect(startedBody.job).toMatchObject({ id: "started-job", recordingId: RECORDING_ID, state: "starting" });
    expect(startedManager.getCurrentJob).toHaveBeenCalledTimes(2);
    expect(startedManager.startJob).toHaveBeenCalledWith({ recordingId: RECORDING_ID });
    expect(probeProcess).toHaveBeenCalledWith(4242);
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

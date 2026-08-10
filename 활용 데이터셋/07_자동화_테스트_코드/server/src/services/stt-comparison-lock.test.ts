import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireSttComparisonLock,
  readSttComparisonLock,
  SttComparisonLockError,
  type SttComparisonLockRecord
} from "./stt-comparison-lock.js";

const RECORDING_ID = "123e4567-e89b-42d3-a456-426614174000";
const TOKEN_A = "123e4567-e89b-42d3-a456-426614174001";
const TOKEN_B = "123e4567-e89b-42d3-a456-426614174002";
const roots: string[] = [];

async function temporaryLockPath(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "stt-comparison-lock-"));
  roots.push(root);
  return path.join(root, ".stt-comparison.lock");
}

function existingRecord(overrides: Partial<SttComparisonLockRecord> = {}): SttComparisonLockRecord {
  return {
    ownerToken: TOKEN_A,
    pid: 99,
    jobId: "existing-job",
    owner: "ui",
    recordingId: RECORDING_ID,
    acquiredAt: "2026-08-09T00:00:00.000Z",
    ...overrides
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("STT comparison cross-process lock", () => {
  it("creates an atomic 0600 lock with owner metadata and releases only its token", async () => {
    const lockPath = await temporaryLockPath();
    const lock = await acquireSttComparisonLock({
      lockPath,
      jobId: "job-a",
      owner: "cli",
      recordingId: RECORDING_ID
    }, {
      now: () => new Date("2026-08-09T01:02:03.000Z"),
      randomToken: () => TOKEN_A,
      pid: 321
    });

    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual({
      ownerToken: TOKEN_A,
      pid: 321,
      jobId: "job-a",
      owner: "cli",
      recordingId: RECORDING_ID,
      acquiredAt: "2026-08-09T01:02:03.000Z"
    });
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
    await expect(readSttComparisonLock(lockPath)).resolves.toMatchObject({ jobId: "job-a", owner: "cli" });

    await writeFile(lockPath, `${JSON.stringify(existingRecord({ ownerToken: TOKEN_B }))}\n`, { mode: 0o600 });
    expect(await lock.release()).toBe(false);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ ownerToken: TOKEN_B });
  });

  it("rejects a live owner and exposes its diagnostics", async () => {
    const lockPath = await temporaryLockPath();
    await writeFile(lockPath, `${JSON.stringify(existingRecord({ pid: process.pid }))}\n`, { mode: 0o600 });

    await expect(acquireSttComparisonLock({
      lockPath,
      jobId: "job-b",
      owner: "ui",
      recordingId: RECORDING_ID
    })).rejects.toMatchObject({
      name: "SttComparisonLockError",
      code: "LOCKED",
      record: { jobId: "existing-job", pid: process.pid }
    });
  });

  it("reclaims an unchanged stale lock only when PID probing returns ESRCH", async () => {
    const lockPath = await temporaryLockPath();
    await writeFile(lockPath, `${JSON.stringify(existingRecord())}\n`, { mode: 0o600 });
    const probes: number[] = [];

    const lock = await acquireSttComparisonLock({
      lockPath,
      jobId: "replacement-job",
      owner: "ui",
      recordingId: RECORDING_ID
    }, {
      randomToken: () => TOKEN_B,
      pid: 100,
      probeProcess: (pid) => {
        probes.push(pid);
        throw Object.assign(new Error("missing"), { code: "ESRCH" });
      }
    });

    expect(probes).toEqual([99]);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({
      ownerToken: TOKEN_B,
      jobId: "replacement-job",
      pid: 100
    });
    expect(await lock.release()).toBe(true);
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed for malformed, over-permissive, and symlink locks", async () => {
    const malformedPath = await temporaryLockPath();
    await writeFile(malformedPath, "not-json", { mode: 0o600 });
    await expect(acquireSttComparisonLock({
      lockPath: malformedPath,
      jobId: "job-c",
      owner: "ui",
      recordingId: RECORDING_ID
    })).rejects.toMatchObject({ code: "MALFORMED" });
    expect(await readFile(malformedPath, "utf8")).toBe("not-json");

    const permissivePath = await temporaryLockPath();
    await writeFile(permissivePath, `${JSON.stringify(existingRecord())}\n`, { mode: 0o644 });
    await expect(acquireSttComparisonLock({
      lockPath: permissivePath,
      jobId: "job-d",
      owner: "ui",
      recordingId: RECORDING_ID
    })).rejects.toMatchObject({ code: "UNSAFE" });

    const symlinkPath = await temporaryLockPath();
    const targetPath = `${symlinkPath}.target`;
    await writeFile(targetPath, `${JSON.stringify(existingRecord())}\n`, { mode: 0o600 });
    await symlink(targetPath, symlinkPath);
    await expect(acquireSttComparisonLock({
      lockPath: symlinkPath,
      jobId: "job-e",
      owner: "ui",
      recordingId: RECORDING_ID
    })).rejects.toBeInstanceOf(SttComparisonLockError);
    expect(await readFile(targetPath, "utf8")).toContain(TOKEN_A);
  });

  it("does not reclaim when PID probing fails with anything except ESRCH", async () => {
    const lockPath = await temporaryLockPath();
    await writeFile(lockPath, `${JSON.stringify(existingRecord())}\n`, { mode: 0o600 });

    await expect(acquireSttComparisonLock({
      lockPath,
      jobId: "job-f",
      owner: "ui",
      recordingId: RECORDING_ID
    }, {
      probeProcess: () => {
        throw Object.assign(new Error("denied"), { code: "EIO" });
      }
    })).rejects.toMatchObject({ code: "UNSAFE" });
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ ownerToken: TOKEN_A });
  });
});

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, unlink, type FileHandle } from "node:fs/promises";

export const STT_COMPARISON_LOCK_FILE = ".stt-comparison.lock";

export type SttComparisonLockOwner = "cli" | "ui";

export type SttComparisonLockRecord = {
  ownerToken: string;
  pid: number;
  jobId: string;
  owner: SttComparisonLockOwner;
  recordingId: string;
  acquiredAt: string;
};

export type SttComparisonLockErrorCode = "LOCKED" | "MALFORMED" | "UNSAFE";

export class SttComparisonLockError extends Error {
  constructor(
    message: string,
    readonly code: SttComparisonLockErrorCode,
    readonly record?: SttComparisonLockRecord
  ) {
    super(message);
    this.name = "SttComparisonLockError";
  }
}

export type AcquireSttComparisonLockOptions = {
  lockPath: string;
  jobId: string;
  owner: SttComparisonLockOwner;
  recordingId: string;
};

export type SttComparisonLock = {
  record: SttComparisonLockRecord;
  release: () => Promise<boolean>;
};

export type SttComparisonLockDependencies = {
  now?: () => Date;
  randomToken?: () => string;
  pid?: number;
  probeProcess?: (pid: number) => void;
};

type FileIdentity = {
  dev: number;
  ino: number;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,90}$/;
const LOCK_KEYS = ["acquiredAt", "jobId", "owner", "ownerToken", "pid", "recordingId"];
const MAX_LOCK_BYTES = 4_096;

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function validateRecord(value: unknown): SttComparisonLockRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SttComparisonLockError("STT 비교 lock 내용이 올바르지 않습니다.", "MALFORMED");
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.length !== LOCK_KEYS.length || keys.some((key, index) => key !== LOCK_KEYS[index])) {
    throw new SttComparisonLockError("STT 비교 lock 필드가 올바르지 않습니다.", "MALFORMED");
  }
  if (typeof candidate.ownerToken !== "string" || !UUID_PATTERN.test(candidate.ownerToken)) {
    throw new SttComparisonLockError("STT 비교 lock owner token이 올바르지 않습니다.", "MALFORMED");
  }
  if (typeof candidate.pid !== "number" || !Number.isSafeInteger(candidate.pid) || candidate.pid <= 0) {
    throw new SttComparisonLockError("STT 비교 lock PID가 올바르지 않습니다.", "MALFORMED");
  }
  if (typeof candidate.jobId !== "string" || !JOB_ID_PATTERN.test(candidate.jobId)) {
    throw new SttComparisonLockError("STT 비교 lock job ID가 올바르지 않습니다.", "MALFORMED");
  }
  if (candidate.owner !== "cli" && candidate.owner !== "ui") {
    throw new SttComparisonLockError("STT 비교 lock owner가 올바르지 않습니다.", "MALFORMED");
  }
  if (typeof candidate.recordingId !== "string" || !UUID_PATTERN.test(candidate.recordingId)) {
    throw new SttComparisonLockError("STT 비교 lock recording ID가 올바르지 않습니다.", "MALFORMED");
  }
  if (
    typeof candidate.acquiredAt !== "string" ||
    Number.isNaN(Date.parse(candidate.acquiredAt)) ||
    new Date(candidate.acquiredAt).toISOString() !== candidate.acquiredAt
  ) {
    throw new SttComparisonLockError("STT 비교 lock 시간이 올바르지 않습니다.", "MALFORMED");
  }
  return {
    ownerToken: candidate.ownerToken,
    pid: candidate.pid,
    jobId: candidate.jobId,
    owner: candidate.owner,
    recordingId: candidate.recordingId,
    acquiredAt: candidate.acquiredAt
  };
}

async function closeQuietly(handle: FileHandle | null): Promise<void> {
  await handle?.close().catch(() => undefined);
}

async function readLockSafely(lockPath: string): Promise<{
  record: SttComparisonLockRecord;
  identity: FileIdentity;
}> {
  const pathStats = await lstat(lockPath);
  if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
    throw new SttComparisonLockError("STT 비교 lock이 안전한 일반 파일이 아닙니다.", "UNSAFE");
  }
  if ((pathStats.mode & 0o777) !== 0o600) {
    throw new SttComparisonLockError("STT 비교 lock 권한이 0600이 아닙니다.", "UNSAFE");
  }
  if (pathStats.size <= 0 || pathStats.size > MAX_LOCK_BYTES) {
    throw new SttComparisonLockError("STT 비교 lock 크기가 올바르지 않습니다.", "MALFORMED");
  }

  let handle: FileHandle | null = null;
  try {
    handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStats = await handle.stat();
    if (!openedStats.isFile() || !isIdentity(pathStats, openedStats)) {
      throw new SttComparisonLockError("STT 비교 lock이 확인 중 교체되었습니다.", "UNSAFE");
    }
    const serialized = await handle.readFile({ encoding: "utf8" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized) as unknown;
    } catch {
      throw new SttComparisonLockError("STT 비교 lock JSON이 손상되었습니다.", "MALFORMED");
    }
    return {
      record: validateRecord(parsed),
      identity: { dev: openedStats.dev, ino: openedStats.ino }
    };
  } finally {
    await closeQuietly(handle);
  }
}

async function unlinkMatchingIdentity(lockPath: string, identity: FileIdentity): Promise<boolean> {
  const currentStats = await lstat(lockPath).catch((error: unknown) => {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  });
  if (!currentStats) return false;
  if (!currentStats.isFile() || currentStats.isSymbolicLink() || !isIdentity(currentStats, identity)) return false;
  await unlink(lockPath);
  return true;
}

function defaultProbeProcess(pid: number): void {
  process.kill(pid, 0);
}

async function releaseOwnedLock(
  lockPath: string,
  ownerToken: string
): Promise<boolean> {
  const current = await readLockSafely(lockPath).catch((error: unknown) => {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  });
  if (!current || current.record.ownerToken !== ownerToken) return false;

  const verified = await readLockSafely(lockPath).catch((error: unknown) => {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  });
  if (
    !verified ||
    verified.record.ownerToken !== ownerToken ||
    !isIdentity(verified.identity, current.identity)
  ) return false;
  return unlinkMatchingIdentity(lockPath, verified.identity);
}

export async function readSttComparisonLock(
  lockPath: string
): Promise<SttComparisonLockRecord | null> {
  const current = await readLockSafely(lockPath).catch((error: unknown) => {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  });
  return current?.record ?? null;
}

export async function acquireSttComparisonLock(
  options: AcquireSttComparisonLockOptions,
  dependencies: SttComparisonLockDependencies = {}
): Promise<SttComparisonLock> {
  const now = dependencies.now ?? (() => new Date());
  const randomToken = dependencies.randomToken ?? randomUUID;
  const pid = dependencies.pid ?? process.pid;
  const probeProcess = dependencies.probeProcess ?? defaultProbeProcess;
  const record = validateRecord({
    ownerToken: randomToken(),
    pid,
    jobId: options.jobId,
    owner: options.owner,
    recordingId: options.recordingId,
    acquiredAt: now().toISOString()
  });

  while (true) {
    let handle: FileHandle | null = null;
    let createdIdentity: FileIdentity | null = null;
    try {
      handle = await open(options.lockPath, "wx", 0o600);
      await handle.chmod(0o600);
      const createdStats = await handle.stat();
      createdIdentity = { dev: createdStats.dev, ino: createdStats.ino };
      await handle.writeFile(`${JSON.stringify(record)}\n`, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = null;

      let released = false;
      return {
        record,
        release: async () => {
          if (released) return false;
          released = true;
          return releaseOwnedLock(options.lockPath, record.ownerToken);
        }
      };
    } catch (error) {
      await closeQuietly(handle);
      if (createdIdentity) await unlinkMatchingIdentity(options.lockPath, createdIdentity).catch(() => undefined);
      if (errnoCode(error) !== "EEXIST") throw error;

      const existing = await readLockSafely(options.lockPath).catch((readError: unknown) => {
        if (errnoCode(readError) === "ENOENT") return null;
        throw readError;
      });
      if (!existing) continue;

      try {
        probeProcess(existing.record.pid);
        throw new SttComparisonLockError("다른 STT 비교 작업이 실행 중입니다.", "LOCKED", existing.record);
      } catch (probeError) {
        if (probeError instanceof SttComparisonLockError) throw probeError;
        if (errnoCode(probeError) === "EPERM") {
          throw new SttComparisonLockError("다른 STT 비교 작업이 실행 중입니다.", "LOCKED", existing.record);
        }
        if (errnoCode(probeError) !== "ESRCH") {
          throw new SttComparisonLockError("기존 STT 비교 lock의 PID를 안전하게 확인하지 못했습니다.", "UNSAFE", existing.record);
        }
      }

      const verified = await readLockSafely(options.lockPath).catch((readError: unknown) => {
        if (errnoCode(readError) === "ENOENT") return null;
        throw readError;
      });
      if (!verified) continue;
      if (
        verified.record.ownerToken !== existing.record.ownerToken ||
        !isIdentity(verified.identity, existing.identity)
      ) continue;
      if (!await unlinkMatchingIdentity(options.lockPath, verified.identity)) continue;
    }
  }
}

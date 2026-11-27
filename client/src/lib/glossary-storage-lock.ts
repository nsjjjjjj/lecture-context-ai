export const GLOSSARY_STORAGE_LOCK_NAME = "lecture-context-ai.glossaries.lock";

export type GlossaryStorageLockPort = {
  request: <T>(
    name: string,
    options: { mode: "exclusive" },
    callback: () => T | Promise<T>
  ) => Promise<T>;
};

let fallbackTail: Promise<void> = Promise.resolve();

function browserLockManager(): GlossaryStorageLockPort | null {
  if (typeof navigator === "undefined" || !("locks" in navigator)) return null;
  return (navigator as Navigator & { locks?: GlossaryStorageLockPort }).locks ?? null;
}

/**
 * Serializes every read-modify-write operation. Web Locks provide the cross-tab
 * boundary; the promise queue preserves ordering in browsers without Web Locks.
 */
export async function withGlossaryStorageLock<T>(
  operation: () => T | Promise<T>,
  lockManager: GlossaryStorageLockPort | null = browserLockManager()
): Promise<T> {
  if (lockManager) {
    return lockManager.request(GLOSSARY_STORAGE_LOCK_NAME, { mode: "exclusive" }, operation);
  }

  const previous = fallbackTail;
  let release!: () => void;
  fallbackTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

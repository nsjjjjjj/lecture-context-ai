import { describe, expect, it } from "vitest";
import {
  GLOSSARY_STORAGE_LOCK_NAME,
  withGlossaryStorageLock,
  type GlossaryStorageLockPort
} from "./glossary-storage-lock";

describe("glossary storage mutation lock", () => {
  it("uses one named exclusive browser lock", async () => {
    let requestCount = 0;
    const lockManager: GlossaryStorageLockPort = {
      async request<T>(name: string, options: { mode: "exclusive" }, callback: () => T | Promise<T>) {
        requestCount += 1;
        expect(name).toBe(GLOSSARY_STORAGE_LOCK_NAME);
        expect(options).toEqual({ mode: "exclusive" });
        return callback();
      }
    };

    await expect(withGlossaryStorageLock(() => "saved", lockManager))
      .resolves.toBe("saved");
    expect(requestCount).toBe(1);
  });

  it("keeps fallback mutations ordered even when the first one is asynchronous", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withGlossaryStorageLock(async () => {
      order.push("first-start");
      await firstGate;
      order.push("first-end");
    }, null);
    const second = withGlossaryStorageLock(() => {
      order.push("second");
    }, null);

    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("releases the fallback queue after a failed mutation", async () => {
    await expect(withGlossaryStorageLock(() => {
      throw new Error("write failed");
    }, null)).rejects.toThrow("write failed");

    await expect(withGlossaryStorageLock(() => "next", null)).resolves.toBe("next");
  });
});

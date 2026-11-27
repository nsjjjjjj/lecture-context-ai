// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useExclusiveActionGate } from "./useExclusiveActionGate";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("useExclusiveActionGate", () => {
  it("rejects a same-render duplicate and exposes one shared busy state", async () => {
    const first = deferred<string>();
    const firstAction = vi.fn(() => first.promise);
    const duplicateAction = vi.fn(() => "duplicate");
    const { result } = renderHook(() => useExclusiveActionGate());

    let firstRun!: Promise<string | undefined>;
    let duplicateRun!: Promise<string | undefined>;
    act(() => {
      firstRun = result.current.run(firstAction);
      duplicateRun = result.current.run(duplicateAction);
    });

    expect(result.current.busy).toBe(true);
    await expect(duplicateRun).resolves.toBeUndefined();
    expect(duplicateAction).not.toHaveBeenCalled();

    await act(async () => {
      first.resolve("saved");
      await expect(firstRun).resolves.toBe("saved");
    });
    expect(result.current.busy).toBe(false);
  });
});

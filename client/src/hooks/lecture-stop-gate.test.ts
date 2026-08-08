import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveStopGate } from "./lecture-stop-gate";

const socket = {} as WebSocket;

afterEach(() => {
  vi.useRealTimers();
});

describe("live lecture stop gate", () => {
  it("server ended 전에는 stop promise를 유지하고 complete에서 해제한다", async () => {
    const gate = createLiveStopGate(100);
    const onTimeout = vi.fn();
    const wait = gate.wait(socket, onTimeout);
    let completed = false;
    void wait.then(() => {
      completed = true;
    });

    await Promise.resolve();
    expect(completed).toBe(false);
    expect(gate.isWaiting(socket)).toBe(true);

    expect(gate.complete(socket)).toBe(true);
    await wait;
    expect(completed).toBe(true);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("timeout cleanup이 끝난 뒤 stop promise를 해제한다", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const gate = createLiveStopGate(50);
    const wait = gate.wait(socket, async () => {
      events.push("timeout-start");
      await Promise.resolve();
      events.push("timeout-end");
    });

    await vi.advanceTimersByTimeAsync(50);
    await wait;

    expect(events).toEqual(["timeout-start", "timeout-end"]);
    expect(gate.isWaiting(socket)).toBe(false);
  });

  it("restart/unmount cancel은 이전 wait만 해제하고 늦은 complete를 무시한다", async () => {
    const gate = createLiveStopGate(100);
    const wait = gate.wait(socket, vi.fn());

    expect(gate.cancel(socket)).toBe(true);
    await wait;
    expect(gate.complete(socket)).toBe(false);
  });
});

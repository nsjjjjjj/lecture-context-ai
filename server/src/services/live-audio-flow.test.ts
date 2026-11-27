import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLiveAudioFlowController,
  LIVE_AUDIO_MAX_QUEUED_BYTES,
  LIVE_AUDIO_MAX_QUEUED_LAG_MS
} from "./live-audio-flow.js";

afterEach(() => vi.useRealTimers());

describe("live audio gRPC backpressure", () => {
  it("derives the bounded already-delivered queue from 0.5 seconds of PCM", () => {
    expect(LIVE_AUDIO_MAX_QUEUED_LAG_MS).toBe(500);
    expect(LIVE_AUDIO_MAX_QUEUED_BYTES).toBe(16_000);
  });

  it("queues a binary delivered after false write and flushes it in order on drain", () => {
    vi.useFakeTimers();
    const writes: number[] = [];
    let acceptWrites = false;
    const pauseInput = vi.fn();
    const resumeInput = vi.fn();
    const controller = createLiveAudioFlowController({
      enqueueAudio: (audio) => {
        writes.push(audio[0] ?? -1);
        return acceptWrites ? "accepted" : "backpressure";
      },
      pauseInput,
      resumeInput,
      onTimeout: vi.fn(),
      onOverflow: vi.fn(),
      onClosed: vi.fn()
    });

    expect(controller.writeOrQueue(Buffer.from([1]))).toBe("written");
    expect(controller.writeOrQueue(Buffer.from([2]))).toBe("queued");
    expect(controller.isPaused()).toBe(true);
    expect(writes).toEqual([1]);

    acceptWrites = true;
    controller.resumeFromGrpc();

    expect(writes).toEqual([1, 2]);
    expect(controller.isPaused()).toBe(false);
    expect(pauseInput).toHaveBeenCalledTimes(1);
    expect(resumeInput).toHaveBeenCalledTimes(1);
  });

  it("keeps remaining queued frames paused if flushing hits backpressure again", () => {
    vi.useFakeTimers();
    const writes: number[] = [];
    let call = 0;
    const controller = createLiveAudioFlowController({
      enqueueAudio: (audio) => {
        writes.push(audio[0] ?? -1);
        call += 1;
        return call === 3 ? "accepted" : "backpressure";
      },
      pauseInput: vi.fn(),
      resumeInput: vi.fn(),
      onTimeout: vi.fn(),
      onOverflow: vi.fn(),
      onClosed: vi.fn()
    });

    controller.writeOrQueue(Buffer.from([1]));
    controller.writeOrQueue(Buffer.from([2]));
    controller.writeOrQueue(Buffer.from([3]));
    controller.resumeFromGrpc();

    expect(writes).toEqual([1, 2]);
    expect(controller.isPaused()).toBe(true);

    controller.resumeFromGrpc();
    expect(writes).toEqual([1, 2, 3]);
    expect(controller.isPaused()).toBe(false);
  });

  it("flushes every controller-queued PCM frame in order before finishInput may run", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    let acceptWrites = false;
    const controller = createLiveAudioFlowController({
      enqueueAudio: (audio) => {
        events.push(`pcm:${audio[0]}`);
        return acceptWrites ? "accepted" : "backpressure";
      },
      pauseInput: vi.fn(),
      resumeInput: () => events.push("socket:resume"),
      onTimeout: vi.fn(),
      onOverflow: vi.fn(),
      onClosed: vi.fn()
    });

    controller.writeOrQueue(Buffer.from([1]));
    controller.writeOrQueue(Buffer.from([2]));
    controller.writeOrQueue(Buffer.from([3]));
    const flushed = controller.flushBeforeFinishInput().then((result) => {
      events.push(`flush:${result}`);
    });
    await Promise.resolve();
    expect(events).toEqual(["pcm:1"]);

    acceptWrites = true;
    controller.resumeFromGrpc();
    await flushed;
    events.push("session:finishInput");

    expect(events).toEqual([
      "pcm:1",
      "pcm:2",
      "pcm:3",
      "socket:resume",
      "flush:flushed",
      "session:finishInput"
    ]);
    expect(controller.isPaused()).toBe(false);
  });

  it("settles a pending stop flush when socket cleanup disposes the flow", async () => {
    vi.useFakeTimers();
    const controller = createLiveAudioFlowController({
      enqueueAudio: () => "backpressure",
      pauseInput: vi.fn(),
      resumeInput: vi.fn(),
      onTimeout: vi.fn(),
      onOverflow: vi.fn(),
      onClosed: vi.fn()
    });

    controller.writeOrQueue(Buffer.from([1]));
    controller.writeOrQueue(Buffer.from([2]));
    const result = controller.flushBeforeFinishInput();
    controller.dispose();

    await expect(result).resolves.toBe("disposed");
  });

  it("fails explicitly instead of silently dropping when the bounded queue overflows", () => {
    vi.useFakeTimers();
    const resumeInput = vi.fn();
    const onOverflow = vi.fn();
    const controller = createLiveAudioFlowController({
      enqueueAudio: () => "backpressure",
      pauseInput: vi.fn(),
      resumeInput,
      onTimeout: vi.fn(),
      onOverflow,
      onClosed: vi.fn(),
      maxQueuedBytes: 3
    });

    controller.writeOrQueue(Buffer.from([1]));
    expect(controller.writeOrQueue(Buffer.from([2, 3]))).toBe("queued");
    expect(controller.writeOrQueue(Buffer.from([4, 5]))).toBe("overflow");
    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(resumeInput).toHaveBeenCalledTimes(1);
  });

  it("fails and resumes input when drain does not arrive before the bounded timeout", () => {
    vi.useFakeTimers();
    const resumeInput = vi.fn();
    const onTimeout = vi.fn();
    const controller = createLiveAudioFlowController({
      enqueueAudio: () => "backpressure",
      pauseInput: vi.fn(),
      resumeInput,
      onTimeout,
      onOverflow: vi.fn(),
      onClosed: vi.fn(),
      timeoutMs: 50
    });

    controller.writeOrQueue(Buffer.from([1]));
    vi.advanceTimersByTime(49);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(resumeInput).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(controller.isPaused()).toBe(false);
  });

  it("clears a pending timeout during socket cleanup without resuming a closing socket", () => {
    vi.useFakeTimers();
    const resumeInput = vi.fn();
    const onTimeout = vi.fn();
    const controller = createLiveAudioFlowController({
      enqueueAudio: () => "backpressure",
      pauseInput: vi.fn(),
      resumeInput,
      onTimeout,
      onOverflow: vi.fn(),
      onClosed: vi.fn(),
      timeoutMs: 25
    });

    controller.writeOrQueue(Buffer.from([1]));
    controller.dispose();
    vi.advanceTimersByTime(25);

    expect(resumeInput).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("reports a provider-closed session without entering backpressure", () => {
    const onClosed = vi.fn();
    const controller = createLiveAudioFlowController({
      enqueueAudio: () => "closed",
      pauseInput: vi.fn(),
      resumeInput: vi.fn(),
      onTimeout: vi.fn(),
      onOverflow: vi.fn(),
      onClosed
    });

    expect(controller.writeOrQueue(Buffer.from([1]))).toBe("closed");
    expect(controller.isPaused()).toBe(false);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });
});

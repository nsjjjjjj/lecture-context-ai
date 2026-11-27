import { describe, expect, it, vi } from "vitest";
import {
  AWS_AUDIO_MAX_QUEUED_BYTES,
  AwsAudioQueue,
  AwsAudioQueueOverflowError
} from "./aws-audio-queue.js";

describe("AWS bounded audio queue", () => {
  it("uses exactly 0.5 seconds of 16 kHz mono PCM as its hard bound", () => {
    expect(AWS_AUDIO_MAX_QUEUED_BYTES).toBe(16_000);
  });

  it("preserves chunk order and drains remaining audio before finish", async () => {
    const queue = new AwsAudioQueue({ maxQueuedBytes: 10, highWatermarkBytes: 8, lowWatermarkBytes: 4 });
    expect(queue.enqueue(Buffer.from([1, 2]))).toBe("accepted");
    expect(queue.enqueue(Buffer.from([3, 4]))).toBe("accepted");
    queue.finish();

    const iterator = queue[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { AudioEvent: { AudioChunk: Buffer.from([1, 2]) } } });
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { AudioEvent: { AudioChunk: Buffer.from([3, 4]) } } });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("returns backpressure at the high watermark and signals once below the low watermark", async () => {
    const onLowWatermark = vi.fn();
    const queue = new AwsAudioQueue({
      maxQueuedBytes: 10,
      highWatermarkBytes: 8,
      lowWatermarkBytes: 4,
      onLowWatermark
    });

    expect(queue.enqueue(Buffer.alloc(4, 1))).toBe("accepted");
    expect(queue.enqueue(Buffer.alloc(4, 2))).toBe("backpressure");
    const iterator = queue[Symbol.asyncIterator]();
    await iterator.next();
    expect(onLowWatermark).toHaveBeenCalledTimes(1);
  });

  it("fails closed on overflow without dropping an older queued chunk", async () => {
    const onOverflow = vi.fn();
    const queue = new AwsAudioQueue({
      maxQueuedBytes: 6,
      highWatermarkBytes: 5,
      lowWatermarkBytes: 2,
      onOverflow
    });

    expect(queue.enqueue(Buffer.from([1, 2, 3, 4]))).toBe("accepted");
    expect(queue.enqueue(Buffer.from([5, 6, 7]))).toBe("closed");
    expect(onOverflow).toHaveBeenCalledWith(expect.any(AwsAudioQueueOverflowError));
    await expect(queue[Symbol.asyncIterator]().next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("delivers directly to a waiting AWS iterator and abort ends it immediately", async () => {
    const onFirstAudio = vi.fn();
    const queue = new AwsAudioQueue({ onFirstAudio });
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();

    expect(queue.enqueue(Buffer.from([9, 8]))).toBe("accepted");
    await expect(pending).resolves.toMatchObject({ value: { AudioEvent: { AudioChunk: Buffer.from([9, 8]) } } });
    expect(onFirstAudio).toHaveBeenCalledTimes(1);

    const waitingForMore = iterator.next();
    queue.abort();
    await expect(waitingForMore).resolves.toEqual({ done: true, value: undefined });
    expect(queue.enqueue(Buffer.from([7]))).toBe("closed");
  });
});

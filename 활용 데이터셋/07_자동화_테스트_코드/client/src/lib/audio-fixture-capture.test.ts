import { describe, expect, it, vi } from "vitest";
import { AudioFixtureCapture, MAX_FIXTURE_PCM_BYTES, type PcmRecorderPort } from "./audio-fixture-capture";

class FakeRecorder implements PcmRecorderPort {
  callback: ((buffer: ArrayBuffer) => void) | null = null;
  stopCalls = 0;

  constructor(private readonly startResult: () => Promise<void> = async () => undefined) {}

  async start(callback: (buffer: ArrayBuffer) => void): Promise<void> {
    this.callback = callback;
    await this.startResult();
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  emit(bytes: number[]): void {
    this.callback?.(new Uint8Array(bytes).buffer);
  }

  emitBuffer(bytes: Uint8Array): void {
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    this.callback?.(copy);
  }
}

describe("audio fixture capture ownership", () => {
  it("deduplicates manual/auto stop races and encodes the captured bytes once", async () => {
    const recorder = new FakeRecorder();
    const capture = new AudioFixtureCapture(() => recorder);
    const session = await capture.start();
    expect(session).not.toBeNull();
    recorder.emit([1, 2, 3, 4]);

    const [manual, automatic] = await Promise.all([
      capture.stop(session!.id),
      capture.stop(session!.id)
    ]);

    expect(recorder.stopCalls).toBe(1);
    expect(manual?.dataBytes).toBe(4);
    expect(automatic?.dataBytes).toBe(4);
    expect([...new Uint8Array(manual!.wav)]).toEqual([...new Uint8Array(automatic!.wav)]);
  });

  it("releases a recorder whose permission request resolves after unmount", async () => {
    let resolveStart!: () => void;
    const recorder = new FakeRecorder(() => new Promise<void>((resolve) => { resolveStart = resolve; }));
    const capture = new AudioFixtureCapture(() => recorder);
    const start = capture.start();

    await Promise.resolve();
    const dispose = capture.dispose();
    resolveStart();

    expect(await start).toBeNull();
    await dispose;
    expect(recorder.stopCalls).toBeGreaterThanOrEqual(1);
  });

  it("recovers after permission denial and allows a retry with a new recorder", async () => {
    const denied = new FakeRecorder(async () => { throw new DOMException("denied", "NotAllowedError"); });
    const retry = new FakeRecorder();
    const createRecorder = vi.fn()
      .mockReturnValueOnce(denied)
      .mockReturnValueOnce(retry);
    const capture = new AudioFixtureCapture(createRecorder);

    await expect(capture.start()).rejects.toMatchObject({ name: "NotAllowedError" });
    const session = await capture.start();
    retry.emit([1, 2]);
    expect((await capture.stop(session!.id))?.dataBytes).toBe(2);
    expect(denied.stopCalls).toBe(1);
    expect(createRecorder).toHaveBeenCalledTimes(2);
  });

  it("hard-caps PCM bytes and emits one limit state even when more audio arrives", async () => {
    const recorder = new FakeRecorder();
    const capture = new AudioFixtureCapture(() => recorder);
    const session = await capture.start();
    const onLimit = vi.fn();
    void session!.limitReached.then(onLimit);

    recorder.emitBuffer(new Uint8Array(MAX_FIXTURE_PCM_BYTES - 2));
    recorder.emit([1, 2, 3, 4]);
    recorder.emit([5, 6, 7, 8]);

    expect(await session!.limitReached).toBe(true);
    const [firstStop, duplicateStop] = await Promise.all([
      capture.stop(session!.id),
      capture.stop(session!.id)
    ]);
    await Promise.resolve();

    expect(firstStop?.dataBytes).toBe(MAX_FIXTURE_PCM_BYTES);
    expect(duplicateStop?.dataBytes).toBe(MAX_FIXTURE_PCM_BYTES);
    expect(onLimit).toHaveBeenCalledTimes(1);
    expect(recorder.stopCalls).toBe(1);
  });
});

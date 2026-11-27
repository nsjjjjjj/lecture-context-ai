import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PCM_AUDIO_WORKLET_FLUSH_TIMEOUT_MS,
  PCM_TARGET_SAMPLE_RATE,
  PcmRecorder,
  PcmRecorderStartCancelledError,
  resolvePcmProcessorBufferSize
} from "./pcm-recorder";

function createRecorderHarness(initialState: AudioContextState = "running") {
  const trackListeners = new Map<string, () => void>();
  const track = {
    addEventListener: vi.fn((name: string, callback: () => void) => trackListeners.set(name, callback)),
    removeEventListener: vi.fn((name: string) => trackListeners.delete(name)),
    stop: vi.fn()
  };
  const stream = { getTracks: vi.fn(() => [track]) };
  const processor = {
    onaudioprocess: null as ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null,
    connect: vi.fn(),
    disconnect: vi.fn()
  };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  let state = initialState;
  const context = {
    get state() {
      return state;
    },
    sampleRate: 48_000,
    destination: {},
    resume: vi.fn(async () => {
      state = "running";
    }),
    close: vi.fn(async () => {
      state = "closed";
    }),
    addEventListener: vi.fn((name: string, callback: () => void) => trackListeners.set(`context:${name}`, callback)),
    removeEventListener: vi.fn((name: string) => trackListeners.delete(`context:${name}`)),
    createMediaStreamSource: vi.fn(() => source),
    createScriptProcessor: vi.fn(() => processor)
  };
  const getUserMedia = vi.fn(async () => stream as unknown as MediaStream);
  const recorder = new PcmRecorder({
    getUserMedia,
    createAudioContext: () => context as unknown as AudioContext
  });

  return { recorder, getUserMedia, context, source, processor, track, trackListeners, setState: (next: AudioContextState) => { state = next; } };
}

function createAudioWorkletHarness() {
  const harness = createRecorderHarness();
  const addModule = vi.fn(async () => undefined);
  Object.assign(harness.context, { audioWorklet: { addModule } });
  const listeners = new Map<string, () => void>();
  const port = {
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
    postMessage: vi.fn()
  };
  const workletNode = {
    port,
    connect: vi.fn(),
    disconnect: vi.fn(),
    addEventListener: vi.fn((name: string, callback: () => void) => listeners.set(name, callback)),
    removeEventListener: vi.fn((name: string) => listeners.delete(name))
  };
  const createAudioWorkletNode = vi.fn(() => workletNode as unknown as AudioWorkletNode);
  const recorder = new PcmRecorder({
    getUserMedia: harness.getUserMedia,
    createAudioContext: () => harness.context as unknown as AudioContext,
    createAudioWorkletNode,
    workletModuleUrl: "/test/pcm-worklet.js"
  });
  return { ...harness, recorder, addModule, port, workletNode, createAudioWorkletNode, listeners };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PcmRecorder live capture", () => {
  it("uses AudioWorklet as the primary path and flushes its final PCM before cleanup", async () => {
    const harness = createAudioWorkletHarness();
    const onAudio = vi.fn();
    const onFirstPcm = vi.fn();

    await harness.recorder.start(onAudio, { onFirstPcm });

    expect(harness.addModule).toHaveBeenCalledWith("/test/pcm-worklet.js");
    expect(harness.createAudioWorkletNode).toHaveBeenCalledWith(
      harness.context,
      "lecture-pcm-processor",
      expect.objectContaining({
        processorOptions: { targetSampleRate: 16_000, chunkDurationMs: 100 }
      })
    );
    expect(harness.context.createScriptProcessor).not.toHaveBeenCalled();
    expect(harness.source.connect).toHaveBeenCalledWith(harness.workletNode);

    const regularPcm = new ArrayBuffer(3_200);
    harness.port.onmessage?.({ data: { type: "pcm", buffer: regularPcm } } as MessageEvent);
    expect(onAudio).toHaveBeenCalledWith(regularPcm);
    expect(onFirstPcm).toHaveBeenCalledOnce();

    const stopping = harness.recorder.stop();
    expect(harness.port.postMessage).toHaveBeenCalledWith({ type: "flush" });
    const remainder = new ArrayBuffer(640);
    harness.port.onmessage?.({ data: { type: "pcm", buffer: remainder } } as MessageEvent);
    harness.port.onmessage?.({ data: { type: "flushed" } } as MessageEvent);
    await stopping;

    expect(onAudio).toHaveBeenLastCalledWith(remainder);
    expect(onFirstPcm).toHaveBeenCalledOnce();
    expect(harness.workletNode.disconnect).toHaveBeenCalledOnce();
    expect(harness.port.onmessage).toBeNull();
  });

  it("falls back to ScriptProcessor when AudioWorklet module setup is unavailable", async () => {
    const harness = createAudioWorkletHarness();
    harness.addModule.mockRejectedValueOnce(new Error("blocked by browser policy"));

    await harness.recorder.start(vi.fn());

    expect(harness.createAudioWorkletNode).not.toHaveBeenCalled();
    expect(harness.context.createScriptProcessor).toHaveBeenCalledWith(4_096, 1, 1);
    await harness.recorder.stop();
  });

  it("reports an AudioWorklet flush timeout instead of treating a truncated tail as success", async () => {
    vi.useFakeTimers();
    const harness = createAudioWorkletHarness();
    await harness.recorder.start(vi.fn());

    const stopping = harness.recorder.stop();
    await vi.advanceTimersByTimeAsync(PCM_AUDIO_WORKLET_FLUSH_TIMEOUT_MS);

    await expect(stopping).rejects.toThrow("마지막 마이크 오디오 처리 시간이 초과되었습니다.");
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.context.close).toHaveBeenCalledOnce();
  });

  it("cancels a pending permission request without reviving capture afterward", async () => {
    let resolveStream!: (stream: MediaStream) => void;
    const pendingStream = new Promise<MediaStream>((resolve) => {
      resolveStream = resolve;
    });
    const harness = createRecorderHarness();
    const track = harness.track;
    const recorder = new PcmRecorder({
      getUserMedia: () => pendingStream,
      createAudioContext: () => harness.context as unknown as AudioContext
    });
    const starting = recorder.start(vi.fn());

    await recorder.stop();
    resolveStream({ getTracks: () => [track] } as unknown as MediaStream);

    await expect(starting).rejects.toBeInstanceOf(PcmRecorderStartCancelledError);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(harness.context.createMediaStreamSource).not.toHaveBeenCalled();
  });

  it("disables destructive preprocessing, resumes a suspended context, and reports first PCM once", async () => {
    const harness = createRecorderHarness("suspended");
    const onAudio = vi.fn();
    const onFirstPcm = vi.fn();

    await harness.recorder.start(onAudio, { onFirstPcm });

    expect(harness.getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: 1,
        sampleRate: { ideal: PCM_TARGET_SAMPLE_RATE },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      video: false
    });
    expect(harness.context.resume).toHaveBeenCalledTimes(1);
    expect(harness.context.createScriptProcessor).toHaveBeenCalledWith(4_096, 1, 1);

    const event = { inputBuffer: { getChannelData: () => new Float32Array(4_096).fill(0.25) } };
    harness.processor.onaudioprocess?.(event);
    harness.processor.onaudioprocess?.(event);

    expect(onFirstPcm).toHaveBeenCalledTimes(1);
    expect(onAudio).toHaveBeenCalledTimes(2);
    expect(onAudio.mock.calls[0]?.[0]).toBeInstanceOf(ArrayBuffer);
    expect((onAudio.mock.calls[0]?.[0] as ArrayBuffer).byteLength).toBeGreaterThan(0);
  });

  it("fails closed and cleans every acquired resource when the context is not running", async () => {
    const harness = createRecorderHarness("interrupted" as AudioContextState);
    harness.context.resume.mockImplementation(async () => undefined);

    await expect(harness.recorder.start(vi.fn())).rejects.toThrow("오디오 처리를 시작하지 못했습니다");

    expect(harness.track.stop).toHaveBeenCalledTimes(1);
    expect(harness.context.close).toHaveBeenCalledTimes(1);
    expect(harness.source.connect).not.toHaveBeenCalled();
  });

  it("reports an unexpected track end once and removes the listener during cleanup", async () => {
    const harness = createRecorderHarness();
    const onError = vi.fn();
    await harness.recorder.start(vi.fn(), { onError });

    harness.trackListeners.get("ended")?.();
    harness.trackListeners.get("ended")?.();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "마이크 입력이 중단되었습니다." }));

    await harness.recorder.stop();
    expect(harness.processor.onaudioprocess).toBeNull();
    expect(harness.processor.disconnect).toHaveBeenCalledTimes(1);
    expect(harness.source.disconnect).toHaveBeenCalledTimes(1);
    expect(harness.track.removeEventListener).toHaveBeenCalledWith("ended", expect.any(Function));
    expect(harness.track.stop).toHaveBeenCalledTimes(1);
    expect(harness.context.close).toHaveBeenCalledTimes(1);
  });

  it("reports a context that stops running after capture started", async () => {
    const harness = createRecorderHarness();
    const onError = vi.fn();
    await harness.recorder.start(vi.fn(), { onError });

    harness.setState("suspended");
    harness.trackListeners.get("context:statechange")?.();
    harness.trackListeners.get("context:statechange")?.();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "마이크 오디오 처리가 중단되었습니다." }));
    await harness.recorder.stop();
    expect(harness.context.removeEventListener).toHaveBeenCalledWith("statechange", expect.any(Function));
  });
});

describe("PCM chunk cadence", () => {
  it("selects the nearest ScriptProcessor power of two to a 100ms capture frame", () => {
    expect(resolvePcmProcessorBufferSize(16_000)).toBe(2_048);
    expect(resolvePcmProcessorBufferSize(44_100)).toBe(4_096);
    expect(resolvePcmProcessorBufferSize(48_000)).toBe(4_096);
    expect(resolvePcmProcessorBufferSize(96_000)).toBe(8_192);
  });
});

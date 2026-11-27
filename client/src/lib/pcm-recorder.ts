import pcmAudioWorkletUrl from "./pcm-audio-worklet.ts?worker&url";

export const PCM_TARGET_SAMPLE_RATE = 16_000;
export const PCM_TARGET_CHUNK_DURATION_MS = 100;
export const PCM_AUDIO_WORKLET_FLUSH_TIMEOUT_MS = 1_000;
const PCM_AUDIO_WORKLET_PROCESSOR_NAME = "lecture-pcm-processor";
const SCRIPT_PROCESSOR_SIZES = [256, 512, 1_024, 2_048, 4_096, 8_192, 16_384] as const;

export function resolvePcmProcessorBufferSize(sampleRate: number): number {
  return SCRIPT_PROCESSOR_SIZES.reduce((closest, candidate) =>
    Math.abs((candidate / sampleRate) * 1_000 - PCM_TARGET_CHUNK_DURATION_MS) <
    Math.abs((closest / sampleRate) * 1_000 - PCM_TARGET_CHUNK_DURATION_MS)
      ? candidate
      : closest
  );
}

type PcmRecorderCallbacks = {
  onFirstPcm?: () => void;
  onError?: (error: Error) => void;
};

type PcmRecorderDependencies = {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createAudioContext?: () => AudioContext;
  createAudioWorkletNode?: (
    context: AudioContext,
    name: string,
    options: AudioWorkletNodeOptions
  ) => AudioWorkletNode;
  workletModuleUrl?: string;
};

type PcmAudioWorkletMessage =
  | { type: "pcm"; buffer: ArrayBuffer }
  | { type: "flushed" };

type PendingWorkletFlush = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class PcmRecorderStartCancelledError extends Error {
  constructor() {
    super("마이크 시작이 취소되었습니다.");
    this.name = "PcmRecorderStartCancelledError";
  }
}

function isPcmAudioWorkletMessage(value: unknown): value is PcmAudioWorkletMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  if ((value as { type?: unknown }).type === "flushed") return true;
  return (value as { type?: unknown }).type === "pcm" && (value as { buffer?: unknown }).buffer instanceof ArrayBuffer;
}

function downsample(input: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (sourceRate === targetRate) return input;
  const ratio = sourceRate / targetRate;
  const outputLength = Math.round(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j];
    output[i] = sum / Math.max(1, end - start);
  }
  return output;
}

function floatToInt16(input: Float32Array): ArrayBuffer {
  const output = new ArrayBuffer(input.length * 2);
  const view = new DataView(output);
  input.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  });
  return output;
}

function stopStreamTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Cleanup continues when a browser-owned track has already ended.
    }
  }
}

export class PcmRecorder {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | AudioWorkletNode | null = null;
  private processorKind: "worklet" | "script" | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private trackEndHandlers = new Map<MediaStreamTrack, () => void>();
  private contextStateHandler: (() => void) | null = null;
  private workletProcessorErrorHandler: (() => void) | null = null;
  private pendingWorkletFlush: PendingWorkletFlush | null = null;
  private active = false;
  private firstPcmEmitted = false;
  private generation = 0;
  private starting = false;
  private stopPromise: Promise<void> | null = null;

  constructor(private readonly dependencies: PcmRecorderDependencies = {}) {}

  async start(onAudio: (buffer: ArrayBuffer) => void, callbacks: PcmRecorderCallbacks = {}): Promise<void> {
    if (this.starting || this.active || this.context || this.stream || this.stopPromise) {
      throw new Error("마이크가 이미 실행 중입니다.");
    }
    this.starting = true;
    const startGeneration = ++this.generation;

    const getUserMedia =
      this.dependencies.getUserMedia ?? ((constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints));
    const createAudioContext = this.dependencies.createAudioContext ?? (() => new AudioContext({ latencyHint: "interactive" }));
    let acquiredStream: MediaStream | null = null;

    try {
      acquiredStream = await getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: { ideal: PCM_TARGET_SAMPLE_RATE },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        },
        video: false
      });
      if (this.generation !== startGeneration) {
        throw new PcmRecorderStartCancelledError();
      }
      this.stream = acquiredStream;

      this.context = createAudioContext();
      if (this.context.state === "suspended") await this.context.resume();
      if (this.generation !== startGeneration) throw new PcmRecorderStartCancelledError();
      if (this.context.state !== "running") throw new Error("마이크 오디오 처리를 시작하지 못했습니다.");

      this.source = this.context.createMediaStreamSource(this.stream);
      this.active = true;
      this.firstPcmEmitted = false;

      const reportFailure = (error: Error): void => {
        if (!this.active) return;
        this.active = false;
        callbacks.onError?.(error);
      };
      const emitPcm = (pcm: ArrayBuffer): void => {
        if ((!this.active && !this.pendingWorkletFlush) || pcm.byteLength === 0) return;
        if (!this.firstPcmEmitted) {
          this.firstPcmEmitted = true;
          callbacks.onFirstPcm?.();
        }
        onAudio(pcm);
      };

      this.contextStateHandler = () => {
        if (!this.context || this.context.state === "running" || this.context.state === "closed") return;
        reportFailure(new Error("마이크 오디오 처리가 중단되었습니다."));
      };
      this.context.addEventListener("statechange", this.contextStateHandler);
      for (const track of this.stream.getTracks()) {
        const onEnded = () => reportFailure(new Error("마이크 입력이 중단되었습니다."));
        this.trackEndHandlers.set(track, onEnded);
        track.addEventListener("ended", onEnded);
      }

      const workletStarted = await this.tryStartAudioWorklet(
        startGeneration,
        emitPcm,
        () => reportFailure(new Error("마이크 오디오 처리기가 중단되었습니다."))
      );
      if (this.generation !== startGeneration) throw new PcmRecorderStartCancelledError();
      if (!workletStarted) this.startScriptProcessor(emitPcm);
    } catch (error) {
      if (acquiredStream && this.stream !== acquiredStream) stopStreamTracks(acquiredStream);
      await this.releaseResources(false).catch(() => undefined);
      throw error;
    } finally {
      this.starting = false;
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.generation += 1;
    const operation = this.releaseResources(true);
    this.stopPromise = operation;
    const clearOperation = () => {
      if (this.stopPromise === operation) this.stopPromise = null;
    };
    void operation.then(clearOperation, clearOperation);
    return operation;
  }

  private async tryStartAudioWorklet(
    startGeneration: number,
    emitPcm: (pcm: ArrayBuffer) => void,
    reportProcessorFailure: () => void
  ): Promise<boolean> {
    const context = this.context;
    if (!context?.audioWorklet) return false;
    const createNode =
      this.dependencies.createAudioWorkletNode ??
      (typeof AudioWorkletNode === "undefined"
        ? null
        : (audioContext: AudioContext, name: string, options: AudioWorkletNodeOptions) =>
            new AudioWorkletNode(audioContext, name, options));
    if (!createNode) return false;

    let node: AudioWorkletNode | null = null;
    try {
      await context.audioWorklet.addModule(this.dependencies.workletModuleUrl ?? pcmAudioWorkletUrl);
      if (this.generation !== startGeneration || this.context !== context) throw new PcmRecorderStartCancelledError();
      node = createNode(context, PCM_AUDIO_WORKLET_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: {
          targetSampleRate: PCM_TARGET_SAMPLE_RATE,
          chunkDurationMs: PCM_TARGET_CHUNK_DURATION_MS
        }
      });
      node.port.onmessage = (event: MessageEvent<unknown>) => {
        if (!isPcmAudioWorkletMessage(event.data)) return;
        if (event.data.type === "pcm") {
          emitPcm(event.data.buffer);
          return;
        }
        const pending = this.pendingWorkletFlush;
        if (!pending) return;
        this.pendingWorkletFlush = null;
        clearTimeout(pending.timer);
        pending.resolve();
      };
      this.workletProcessorErrorHandler = reportProcessorFailure;
      node.addEventListener("processorerror", this.workletProcessorErrorHandler);
      this.source?.connect(node);
      node.connect(context.destination);
      this.processor = node;
      this.processorKind = "worklet";
      return true;
    } catch (error) {
      if (node) {
        node.port.onmessage = null;
        if (this.workletProcessorErrorHandler) {
          node.removeEventListener("processorerror", this.workletProcessorErrorHandler);
        }
        try {
          node.disconnect();
        } catch {
          // The fallback remains available after partial worklet setup.
        }
      }
      this.workletProcessorErrorHandler = null;
      if (error instanceof PcmRecorderStartCancelledError) throw error;
      return false;
    }
  }

  private startScriptProcessor(emitPcm: (pcm: ArrayBuffer) => void): void {
    if (!this.context) throw new Error("마이크 오디오 컨텍스트가 없습니다.");
    const processor = this.context.createScriptProcessor(resolvePcmProcessorBufferSize(this.context.sampleRate), 1, 1);
    processor.onaudioprocess = (event) => {
      if (!this.active || !this.context) return;
      const input = event.inputBuffer.getChannelData(0);
      emitPcm(floatToInt16(downsample(input, this.context.sampleRate, PCM_TARGET_SAMPLE_RATE)));
    };
    this.source?.connect(processor);
    processor.connect(this.context.destination);
    this.processor = processor;
    this.processorKind = "script";
  }

  private flushWorklet(): Promise<void> {
    if (this.processorKind !== "worklet" || !this.processor) return Promise.resolve();
    const node = this.processor as AudioWorkletNode;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pendingWorkletFlush) return;
        this.pendingWorkletFlush = null;
        reject(new Error("마지막 마이크 오디오 처리 시간이 초과되었습니다."));
      }, PCM_AUDIO_WORKLET_FLUSH_TIMEOUT_MS);
      this.pendingWorkletFlush = { resolve, reject, timer };
      try {
        node.port.postMessage({ type: "flush" });
      } catch {
        clearTimeout(timer);
        this.pendingWorkletFlush = null;
        reject(new Error("마지막 마이크 오디오를 처리하지 못했습니다."));
      }
    });
  }

  private async releaseResources(flushWorklet: boolean): Promise<void> {
    let failure: unknown = null;
    if (flushWorklet && this.active && this.processorKind === "worklet") {
      try {
        await this.flushWorklet();
      } catch (error) {
        failure = error;
      }
    }
    this.active = false;

    if (this.context && this.contextStateHandler) {
      this.context.removeEventListener("statechange", this.contextStateHandler);
    }
    this.contextStateHandler = null;
    if (this.processorKind === "script" && this.processor) {
      (this.processor as ScriptProcessorNode).onaudioprocess = null;
    }
    if (this.processorKind === "worklet" && this.processor) {
      const node = this.processor as AudioWorkletNode;
      node.port.onmessage = null;
      if (this.workletProcessorErrorHandler) {
        node.removeEventListener("processorerror", this.workletProcessorErrorHandler);
      }
    }
    this.workletProcessorErrorHandler = null;
    if (this.pendingWorkletFlush) {
      const pending = this.pendingWorkletFlush;
      this.pendingWorkletFlush = null;
      clearTimeout(pending.timer);
      pending.reject(new Error("마이크 오디오 처리가 중단되었습니다."));
    }
    try {
      this.processor?.disconnect();
    } catch {
      // A partially initialized or externally closed audio graph may already be detached.
    }
    try {
      this.source?.disconnect();
    } catch {
      // Cleanup continues for every owned resource.
    }
    for (const track of this.stream?.getTracks() ?? []) {
      const onEnded = this.trackEndHandlers.get(track);
      if (onEnded) track.removeEventListener("ended", onEnded);
      try {
        track.stop();
      } catch {
        // Cleanup continues for every owned track.
      }
    }
    this.trackEndHandlers.clear();
    if (this.context && this.context.state !== "closed") {
      try {
        await this.context.close();
      } catch (error) {
        if (!failure) failure = error;
      }
    }
    this.processor = null;
    this.processorKind = null;
    this.source = null;
    this.stream = null;
    this.context = null;
    this.firstPcmEmitted = false;
    if (failure) throw failure;
  }
}

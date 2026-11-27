import { StreamingPcm16Encoder } from "./pcm-audio-processor";

type WorkletProcessorOptions = {
  processorOptions?: {
    targetSampleRate?: number;
    chunkDurationMs?: number;
  };
};

type WorkletProcessorInstance = {
  port: MessagePort;
};

type AudioWorkletScope = typeof globalThis & {
  AudioWorkletProcessor: new () => WorkletProcessorInstance;
  registerProcessor: (name: string, processor: new (options?: WorkletProcessorOptions) => WorkletProcessorInstance) => void;
  sampleRate: number;
};

const workletScope = globalThis as AudioWorkletScope;

class LecturePcmProcessor extends workletScope.AudioWorkletProcessor {
  private readonly encoder: StreamingPcm16Encoder;

  constructor(options: WorkletProcessorOptions = {}) {
    super();
    this.encoder = new StreamingPcm16Encoder({
      sourceSampleRate: workletScope.sampleRate,
      targetSampleRate: options.processorOptions?.targetSampleRate ?? 16_000,
      chunkDurationMs: options.processorOptions?.chunkDurationMs ?? 100
    });
    this.port.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data !== "object" || event.data === null || !("type" in event.data)) return;
      if ((event.data as { type?: unknown }).type !== "flush") return;
      const remainder = this.encoder.flush();
      if (remainder) this.port.postMessage({ type: "pcm", buffer: remainder }, [remainder]);
      this.port.postMessage({ type: "flushed" });
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!input?.length) return true;
    for (const buffer of this.encoder.push(input)) {
      this.port.postMessage({ type: "pcm", buffer }, [buffer]);
    }
    return true;
  }
}

workletScope.registerProcessor("lecture-pcm-processor", LecturePcmProcessor);

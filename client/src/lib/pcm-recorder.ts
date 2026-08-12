export const PCM_TARGET_SAMPLE_RATE = 16_000;
export const PCM_TARGET_CHUNK_DURATION_MS = 100;
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
};

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

export class PcmRecorder {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private trackEndHandlers = new Map<MediaStreamTrack, () => void>();
  private contextStateHandler: (() => void) | null = null;
  private active = false;
  private firstPcmEmitted = false;

  constructor(private readonly dependencies: PcmRecorderDependencies = {}) {}

  async start(onAudio: (buffer: ArrayBuffer) => void, callbacks: PcmRecorderCallbacks = {}): Promise<void> {
    if (this.active || this.context || this.stream) throw new Error("마이크가 이미 실행 중입니다.");

    const getUserMedia =
      this.dependencies.getUserMedia ?? ((constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints));
    const createAudioContext = this.dependencies.createAudioContext ?? (() => new AudioContext({ latencyHint: "interactive" }));

    try {
      this.stream = await getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: { ideal: PCM_TARGET_SAMPLE_RATE },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        },
        video: false
      });

      this.context = createAudioContext();
      if (this.context.state === "suspended") await this.context.resume();
      if (this.context.state !== "running") throw new Error("마이크 오디오 처리를 시작하지 못했습니다.");

      this.source = this.context.createMediaStreamSource(this.stream);
      this.processor = this.context.createScriptProcessor(resolvePcmProcessorBufferSize(this.context.sampleRate), 1, 1);
      this.active = true;
      this.firstPcmEmitted = false;

      const reportFailure = (error: Error): void => {
        if (!this.active) return;
        this.active = false;
        callbacks.onError?.(error);
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

      this.processor.onaudioprocess = (event) => {
        if (!this.active || !this.context) return;
        const input = event.inputBuffer.getChannelData(0);
        const sampled = downsample(input, this.context.sampleRate, PCM_TARGET_SAMPLE_RATE);
        const pcm = floatToInt16(sampled);
        if (pcm.byteLength === 0) return;
        if (!this.firstPcmEmitted) {
          this.firstPcmEmitted = true;
          callbacks.onFirstPcm?.();
        }
        onAudio(pcm);
      };
      this.source.connect(this.processor);
      this.processor.connect(this.context.destination);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.active = false;
    if (this.context && this.contextStateHandler) {
      this.context.removeEventListener("statechange", this.contextStateHandler);
    }
    this.contextStateHandler = null;
    if (this.processor) this.processor.onaudioprocess = null;
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
      track.stop();
    }
    this.trackEndHandlers.clear();
    if (this.context && this.context.state !== "closed") await this.context.close();
    this.processor = null;
    this.source = null;
    this.stream = null;
    this.context = null;
    this.firstPcmEmitted = false;
  }
}

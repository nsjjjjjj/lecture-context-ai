export type StreamingPcm16EncoderOptions = {
  sourceSampleRate: number;
  targetSampleRate: number;
  chunkDurationMs: number;
};

function toPcm16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

/**
 * Stateful resampling matters here: AudioWorklet delivers small render quanta,
 * so rounding every quantum independently would slowly change the audio clock.
 */
export class StreamingPcm16Encoder {
  private readonly sourceSamplesPerTargetSample: number;
  private readonly chunkSampleCount: number;
  private sourceSamplesSeen = 0;
  private nextTargetBoundary: number;
  private targetAccumulator = 0;
  private targetAccumulatorWeight = 0;
  private chunk: Int16Array;
  private chunkCursor = 0;

  constructor(options: StreamingPcm16EncoderOptions) {
    if (
      !Number.isFinite(options.sourceSampleRate) ||
      !Number.isFinite(options.targetSampleRate) ||
      !Number.isFinite(options.chunkDurationMs) ||
      options.sourceSampleRate <= 0 ||
      options.targetSampleRate <= 0 ||
      options.chunkDurationMs <= 0
    ) {
      throw new Error("PCM 인코더 설정이 올바르지 않습니다.");
    }
    this.sourceSamplesPerTargetSample = options.sourceSampleRate / options.targetSampleRate;
    this.nextTargetBoundary = this.sourceSamplesPerTargetSample;
    this.chunkSampleCount = Math.max(1, Math.round((options.targetSampleRate * options.chunkDurationMs) / 1_000));
    this.chunk = new Int16Array(this.chunkSampleCount);
  }

  push(input: Float32Array): ArrayBuffer[] {
    const completed: ArrayBuffer[] = [];
    for (const sample of input) {
      const sourceSampleEnd = this.sourceSamplesSeen + 1;
      let cursor = this.sourceSamplesSeen;
      while (cursor < sourceSampleEnd - 1e-10) {
        const overlapEnd = Math.min(sourceSampleEnd, this.nextTargetBoundary);
        const weight = Math.max(0, overlapEnd - cursor);
        this.targetAccumulator += sample * weight;
        this.targetAccumulatorWeight += weight;
        cursor = overlapEnd;

        if (cursor >= this.nextTargetBoundary - 1e-10) {
          this.writeTargetSample(
            this.targetAccumulatorWeight > 0 ? this.targetAccumulator / this.targetAccumulatorWeight : sample,
            completed
          );
          this.targetAccumulator = 0;
          this.targetAccumulatorWeight = 0;
          this.nextTargetBoundary += this.sourceSamplesPerTargetSample;
        }
      }
      this.sourceSamplesSeen = sourceSampleEnd;
    }
    return completed;
  }

  flush(): ArrayBuffer | null {
    const completed: ArrayBuffer[] = [];
    if (this.targetAccumulatorWeight > 0) {
      this.writeTargetSample(this.targetAccumulator / this.targetAccumulatorWeight, completed);
      this.targetAccumulator = 0;
      this.targetAccumulatorWeight = 0;
    }
    if (completed[0]) return completed[0];
    if (this.chunkCursor === 0) return null;
    const remainder = this.chunk.slice(0, this.chunkCursor).buffer;
    this.chunk = new Int16Array(this.chunkSampleCount);
    this.chunkCursor = 0;
    return remainder;
  }

  private writeTargetSample(sample: number, completed: ArrayBuffer[]): void {
    this.chunk[this.chunkCursor] = toPcm16(sample);
    this.chunkCursor += 1;
    if (this.chunkCursor !== this.chunk.length) return;
    completed.push(this.chunk.buffer as ArrayBuffer);
    this.chunk = new Int16Array(this.chunkSampleCount);
    this.chunkCursor = 0;
  }
}

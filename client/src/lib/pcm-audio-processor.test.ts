import { describe, expect, it } from "vitest";
import { StreamingPcm16Encoder } from "./pcm-audio-processor";

describe("StreamingPcm16Encoder", () => {
  it("keeps a stable 100ms clock while 48kHz worklet quanta arrive separately", () => {
    const encoder = new StreamingPcm16Encoder({
      sourceSampleRate: 48_000,
      targetSampleRate: 16_000,
      chunkDurationMs: 100
    });
    const emitted: ArrayBuffer[] = [];
    for (let offset = 0; offset < 4_800; offset += 128) {
      emitted.push(...encoder.push(new Float32Array(Math.min(128, 4_800 - offset)).fill(0.25)));
    }

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.byteLength).toBe(3_200);
    expect(encoder.flush()).toBeNull();
  });

  it("preserves the resampling phase across uneven 44.1kHz input blocks", () => {
    const encoder = new StreamingPcm16Encoder({
      sourceSampleRate: 44_100,
      targetSampleRate: 16_000,
      chunkDurationMs: 100
    });
    const emitted = [
      ...encoder.push(new Float32Array(111).fill(-1)),
      ...encoder.push(new Float32Array(2_000).fill(-1)),
      ...encoder.push(new Float32Array(2_299).fill(-1))
    ];

    expect(emitted).toHaveLength(1);
    expect(new Int16Array(emitted[0] ?? new ArrayBuffer(0))).toHaveLength(1_600);
    expect(new Int16Array(emitted[0] ?? new ArrayBuffer(0))[0]).toBe(-32_768);
    expect(encoder.flush()).toBeNull();
  });

  it("flushes only the remaining samples and validates its clock configuration", () => {
    const encoder = new StreamingPcm16Encoder({
      sourceSampleRate: 16_000,
      targetSampleRate: 16_000,
      chunkDurationMs: 100
    });
    expect(encoder.push(new Float32Array([1, 0, -1]))).toEqual([]);

    const remainder = encoder.flush();
    expect(Array.from(new Int16Array(remainder ?? new ArrayBuffer(0)))).toEqual([32_767, 0, -32_768]);
    expect(encoder.flush()).toBeNull();
    expect(
      () => new StreamingPcm16Encoder({ sourceSampleRate: 0, targetSampleRate: 16_000, chunkDurationMs: 100 })
    ).toThrow("PCM 인코더 설정이 올바르지 않습니다.");
  });

  it("averages source samples during downsampling instead of aliasing one sample", () => {
    const encoder = new StreamingPcm16Encoder({
      sourceSampleRate: 48_000,
      targetSampleRate: 16_000,
      chunkDurationMs: 100
    });

    encoder.push(new Float32Array([-1, 1, 1]));
    const sample = new Int16Array(encoder.flush() ?? new ArrayBuffer(0))[0];

    expect(sample).toBeGreaterThan(10_900);
    expect(sample).toBeLessThan(11_000);
  });
});

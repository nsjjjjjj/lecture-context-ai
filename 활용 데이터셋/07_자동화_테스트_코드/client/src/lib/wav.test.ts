import { describe, expect, it } from "vitest";
import { encodePcm16Wav, WAV_BYTES_PER_SECOND } from "./wav";

describe("canonical PCM WAV encoding", () => {
  it("writes an exact 16kHz mono 16-bit RIFF header and concatenates PCM bytes", () => {
    const first = new Uint8Array([1, 2, 3, 4]).buffer;
    const second = new Uint8Array([5, 6]).buffer;
    const result = encodePcm16Wav([first, second]);
    const bytes = new Uint8Array(result.wav);
    const view = new DataView(result.wav);

    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(result.wav.byteLength - 8);
    expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe("WAVE");
    expect(new TextDecoder().decode(bytes.subarray(12, 16))).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(WAV_BYTES_PER_SECOND);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(new TextDecoder().decode(bytes.subarray(36, 40))).toBe("data");
    expect(view.getUint32(40, true)).toBe(6);
    expect([...bytes.subarray(44)]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("rejects empty or odd-length PCM", () => {
    expect(() => encodePcm16Wav([])).toThrow("PCM 데이터가 없습니다");
    expect(() => encodePcm16Wav([new Uint8Array([1]).buffer])).toThrow("짝수");
  });
});

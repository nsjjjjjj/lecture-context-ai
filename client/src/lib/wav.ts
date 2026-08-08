export const WAV_SAMPLE_RATE = 16_000;
export const WAV_CHANNELS = 1;
export const WAV_BITS_PER_SAMPLE = 16;
export const WAV_HEADER_BYTES = 44;
export const WAV_BYTES_PER_SECOND = WAV_SAMPLE_RATE * WAV_CHANNELS * (WAV_BITS_PER_SAMPLE / 8);

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}

export function encodePcm16Wav(chunks: readonly ArrayBuffer[]): { wav: ArrayBuffer; dataBytes: number; durationMs: number } {
  const dataBytes = chunks.reduce((total, chunk) => {
    if (chunk.byteLength % 2 !== 0) throw new Error("16-bit PCM 청크 길이는 짝수여야 합니다.");
    return total + chunk.byteLength;
  }, 0);
  if (dataBytes <= 0) throw new Error("녹음된 PCM 데이터가 없습니다.");

  const wav = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(wav);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, WAV_HEADER_BYTES + dataBytes - 8, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, WAV_CHANNELS, true);
  view.setUint32(24, WAV_SAMPLE_RATE, true);
  view.setUint32(28, WAV_BYTES_PER_SECOND, true);
  view.setUint16(32, WAV_CHANNELS * (WAV_BITS_PER_SAMPLE / 8), true);
  view.setUint16(34, WAV_BITS_PER_SAMPLE, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  const output = new Uint8Array(wav, WAV_HEADER_BYTES);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return { wav, dataBytes, durationMs: Math.ceil((dataBytes / WAV_BYTES_PER_SECOND) * 1_000) };
}

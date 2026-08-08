import { describe, expect, it, vi } from "vitest";
import { buildStreamingRecognizeRequest, createGuardedSpeechWriter, isSpeechStreamWritable } from "./speech.js";

describe("buildStreamingRecognizeRequest", () => {
  it("검증된 PhraseSet 값을 Google STT 인라인 적응 설정에 그대로 전달한다", () => {
    const request = buildStreamingRecognizeRequest("project", "us", "chirp_3", [
      "RAG",
      "Retrieval-Augmented Generation"
    ]);

    expect(request.streamingConfig.config.adaptation?.phraseSets[0]?.inlinePhraseSet.phrases).toEqual([
      { value: "RAG" },
      { value: "Retrieval-Augmented Generation" }
    ]);
  });

  it("PhraseSet이 비어 있으면 adaptation 설정을 보내지 않는다", () => {
    const request = buildStreamingRecognizeRequest("project", "us", "chirp_3", []);

    expect(request.streamingConfig.config).not.toHaveProperty("adaptation");
  });
});

describe("guarded Google Speech writes", () => {
  it("종료되거나 파괴된 스트림에는 쓰지 않는다", () => {
    const write = vi.fn();

    expect(isSpeechStreamWritable({ destroyed: true, write })).toBe(false);
    expect(isSpeechStreamWritable({ writableEnded: true, write })).toBe(false);
    expect(isSpeechStreamWritable({ writable: false, write })).toBe(false);
  });

  it("쓰기 오류 뒤의 오디오 청크를 무시하고 오류를 한 번만 알린다", () => {
    const onError = vi.fn();
    const stream = {
      write: vi.fn((_value: unknown, callback?: (error?: Error | null) => void) => {
        callback?.(new Error("Cannot call write after a stream was destroyed"));
      })
    };
    const writer = createGuardedSpeechWriter(stream, onError);

    expect(writer.write({ audio: Buffer.from([1]) })).toBe(true);
    expect(writer.write({ audio: Buffer.from([2]) })).toBe(false);
    expect(stream.write).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("동기 write 예외도 세션 종료 오류로 전환한다", () => {
    const onError = vi.fn();
    const writer = createGuardedSpeechWriter({
      write() {
        throw new Error("stream destroyed");
      }
    }, onError);

    expect(writer.write({ audio: Buffer.from([1]) })).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "stream destroyed" }));
  });
});

import { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildStreamingRecognizeRequest,
  createGoogleSpeechSession,
  createGuardedSpeechWriter,
  getGoogleSpeechConfigurationError,
  isGoogleSpeechConfigured,
  isSpeechStreamWritable,
  type SpeechClientPort
} from "./speech.js";

class RecordingSpeechStream extends Duplex {
  readonly writes: unknown[] = [];

  constructor() {
    super({ objectMode: true });
  }

  override _read(): void {}

  override _write(value: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writes.push(value);
    callback();
  }

  cancel(): void {
    this.destroy();
  }
}

function createRecordingClient(stream: RecordingSpeechStream) {
  return {
    _streamingRecognize: vi.fn(() => stream),
    close: vi.fn(async () => undefined)
  } satisfies SpeechClientPort;
}

function configureSupportedSpeech(): void {
  vi.stubEnv("GOOGLE_CLOUD_PROJECT", "project");
  vi.stubEnv("GOOGLE_STT_LOCATION", "us");
  vi.stubEnv("GOOGLE_STT_MODEL", "chirp_3");
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("Google Speech configuration", () => {
  it("검증된 us/chirp_3 조합만 구성 완료로 판단한다", () => {
    configureSupportedSpeech();

    expect(getGoogleSpeechConfigurationError()).toBeNull();
    expect(isGoogleSpeechConfigured()).toBe(true);
  });

  it("global 또는 다른 모델을 fail closed로 거부한다", () => {
    configureSupportedSpeech();
    vi.stubEnv("GOOGLE_STT_LOCATION", "global");

    expect(getGoogleSpeechConfigurationError()).toContain("'us'");
    expect(isGoogleSpeechConfigured()).toBe(false);
    expect(() => createGoogleSpeechSession([], { onTranscript: vi.fn(), onError: vi.fn(), onEnd: vi.fn() })).toThrow(
      "GOOGLE_STT_LOCATION"
    );

    vi.stubEnv("GOOGLE_STT_LOCATION", "us");
    vi.stubEnv("GOOGLE_STT_MODEL", "latest_long");

    expect(getGoogleSpeechConfigurationError()).toContain("'chirp_3'");
    expect(isGoogleSpeechConfigured()).toBe(false);
    expect(() => createGoogleSpeechSession([], { onTranscript: vi.fn(), onError: vi.fn(), onEnd: vi.fn() })).toThrow(
      "GOOGLE_STT_MODEL"
    );
  });
});

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

describe("Google Speech V2 bidirectional transport", () => {
  it("첫 write에 recognizer와 전체 설정을 변형 없이 보내고 typed V2 bidi 메서드를 사용한다", () => {
    configureSupportedSpeech();
    const stream = new RecordingSpeechStream();
    const client = createRecordingClient(stream);
    const expected = buildStreamingRecognizeRequest("project", "us", "chirp_3", ["RAG"]);

    createGoogleSpeechSession(
      ["RAG"],
      { onTranscript: vi.fn(), onError: vi.fn(), onEnd: vi.fn() },
      { client }
    );

    expect(client._streamingRecognize).toHaveBeenCalledTimes(1);
    expect(stream.writes).toEqual([expected]);
    expect(stream.writes[0]).not.toHaveProperty("audio");
    expect(stream.writes[0]).not.toHaveProperty("audioContent");
  });

  it("후속 write에는 15KB 이하 audio만 보내고 audioContent로 감싸지 않는다", () => {
    configureSupportedSpeech();
    const stream = new RecordingSpeechStream();
    const client = createRecordingClient(stream);
    const onError = vi.fn();
    const onEnd = vi.fn();
    const session = createGoogleSpeechSession(
      [],
      { onTranscript: vi.fn(), onError, onEnd },
      { client }
    );
    const acceptedAudio = Buffer.alloc(15_000, 1);

    session.writeAudio(acceptedAudio);
    session.writeAudio(Buffer.alloc(15_001, 2));

    expect(stream.writes).toHaveLength(2);
    expect(stream.writes[1]).toEqual({ audio: acceptedAudio });
    expect(stream.writes[1]).not.toHaveProperty("audioContent");
    expect(stream.writes[1]).not.toHaveProperty("recognizer");
    expect(stream.writes[1]).not.toHaveProperty("streamingConfig");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("15KB") }));
    expect(onEnd).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledTimes(1);

    stream.emit("end");
    stream.emit("close");
    session.writeAudio(Buffer.from([1, 2]));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(stream.writes).toHaveLength(2);
  });

  it("V2 응답의 임시·확정 자막을 세션 콜백으로 전달한다", () => {
    configureSupportedSpeech();
    const stream = new RecordingSpeechStream();
    const client = createRecordingClient(stream);
    const onTranscript = vi.fn();

    createGoogleSpeechSession(
      [],
      { onTranscript, onError: vi.fn(), onEnd: vi.fn() },
      { client }
    );
    stream.emit("data", {
      results: [{ alternatives: [{ transcript: " 임시 자막 " }], isFinal: false }]
    });
    stream.emit("data", {
      results: [{ alternatives: [{ transcript: "확정 자막" }], isFinal: true }]
    });

    expect(onTranscript).toHaveBeenNthCalledWith(1, "임시 자막", false);
    expect(onTranscript).toHaveBeenNthCalledWith(2, "확정 자막", true);
  });

  it("명시적 close 후 지연된 final을 받은 뒤 readable end에서만 클라이언트를 닫는다", () => {
    configureSupportedSpeech();
    const stream = new RecordingSpeechStream();
    const client = createRecordingClient(stream);
    const events: string[] = [];
    const end = vi.spyOn(stream, "end");
    client.close.mockImplementation(async () => {
      events.push("client-close");
    });
    const session = createGoogleSpeechSession(
      [],
      {
        onTranscript: (_text, isFinal) => events.push(isFinal ? "final" : "interim"),
        onError: () => events.push("error"),
        onEnd: () => events.push("end")
      },
      { client, drainTimeoutMs: 100 }
    );

    session.close();
    session.close();
    session.writeAudio(Buffer.from([1, 2]));

    expect(end).toHaveBeenCalledTimes(1);
    expect(client.close).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(stream.writes).toHaveLength(1);

    stream.emit("data", {
      results: [{ alternatives: [{ transcript: "마지막 확정 자막" }], isFinal: true }]
    });
    stream.emit("end");
    stream.emit("close");
    stream.emit("error", new Error("late error"));

    expect(events).toEqual(["final", "end", "client-close"]);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("스트림 error 뒤 end와 close가 와도 onError만 한 번 호출한다", () => {
    configureSupportedSpeech();
    const stream = new RecordingSpeechStream();
    const client = createRecordingClient(stream);
    const onError = vi.fn();
    const onEnd = vi.fn();
    const session = createGoogleSpeechSession(
      [],
      { onTranscript: vi.fn(), onError, onEnd },
      { client }
    );

    stream.emit("error", new Error("transport failed"));
    stream.emit("end");
    stream.emit("close");
    session.writeAudio(Buffer.from([1, 2]));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(stream.writes).toHaveLength(1);
  });

  it("readable 종료가 없으면 제한 시간 뒤 한 번만 정상 종료하고 강제 정리한다", async () => {
    vi.useFakeTimers();
    configureSupportedSpeech();
    const stream = new RecordingSpeechStream();
    const client = createRecordingClient(stream);
    const onError = vi.fn();
    const onEnd = vi.fn();
    const session = createGoogleSpeechSession(
      [],
      { onTranscript: vi.fn(), onError, onEnd },
      { client, drainTimeoutMs: 50 }
    );

    session.close();
    await vi.advanceTimersByTimeAsync(49);
    expect(client.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledTimes(1);

    stream.emit("end");
    stream.emit("close");
    stream.emit("error", new Error("after timeout"));
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("Google client close가 reject되어도 terminal callback을 뒤집거나 중복하지 않는다", async () => {
    configureSupportedSpeech();
    const stream = new RecordingSpeechStream();
    const client = createRecordingClient(stream);
    client.close.mockRejectedValue(new Error("close rejected"));
    const onError = vi.fn();
    const onEnd = vi.fn();
    const session = createGoogleSpeechSession(
      [],
      { onTranscript: vi.fn(), onError, onEnd },
      { client, drainTimeoutMs: 100 }
    );

    session.close();
    stream.emit("close");
    await Promise.resolve();
    stream.emit("end");

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledTimes(1);
  });
});

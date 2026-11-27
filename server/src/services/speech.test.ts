import { Duplex } from "node:stream";
import { protos } from "@google-cloud/speech";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildStreamingRecognizeRequest,
  createDevelopmentSpeechDiagnosticReporter,
  createGoogleSpeechSession,
  createGuardedSpeechWriter,
  getGoogleSpeechConfigurationError,
  isGoogleSpeechConfigured,
  isSpeechStreamWritable,
  projectStreamingRecognizeResponse,
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

class DelayedWriteSpeechStream extends RecordingSpeechStream {
  private pendingWrite: ((error?: Error | null) => void) | null = null;

  override _write(value: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writes.push(value);
    this.pendingWrite = callback;
  }

  releaseWrite(error?: Error): void {
    const callback = this.pendingWrite;
    this.pendingWrite = null;
    callback?.(error);
  }
}

function createRecordingClient(stream: RecordingSpeechStream) {
  return {
    initialize: vi.fn(async () => ({})),
    _streamingRecognize: vi.fn(() => stream)
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

  it("global 또는 다른 모델을 fail closed로 거부한다", async () => {
    configureSupportedSpeech();
    vi.stubEnv("GOOGLE_STT_LOCATION", "global");

    expect(getGoogleSpeechConfigurationError()).toContain("'us'");
    expect(isGoogleSpeechConfigured()).toBe(false);
    await expect(createGoogleSpeechSession([], { onTranscript: vi.fn(), onError: vi.fn(), onEnd: vi.fn() })).rejects.toThrow(
      "GOOGLE_STT_LOCATION"
    );

    vi.stubEnv("GOOGLE_STT_LOCATION", "us");
    vi.stubEnv("GOOGLE_STT_MODEL", "latest_long");

    expect(getGoogleSpeechConfigurationError()).toContain("'chirp_3'");
    expect(isGoogleSpeechConfigured()).toBe(false);
    await expect(createGoogleSpeechSession([], { onTranscript: vi.fn(), onError: vi.fn(), onEnd: vi.fn() })).rejects.toThrow(
      "GOOGLE_STT_MODEL"
    );
  });
});

describe("buildStreamingRecognizeRequest", () => {
  it("Chirp 3 짧은 발화 endpointing을 SDK enum으로 지정하고 나머지 요청 설정을 보존한다", () => {
    const endpointingSensitivity =
      protos.google.cloud.speech.v2.StreamingRecognitionFeatures.EndpointingSensitivity
        .ENDPOINTING_SENSITIVITY_SHORT;

    expect(endpointingSensitivity).toBe(3);
    expect(buildStreamingRecognizeRequest("project", "us", "chirp_3", [])).toEqual({
      recognizer: "projects/project/locations/us/recognizers/_",
      streamingConfig: {
        config: {
          explicitDecodingConfig: {
            encoding: "LINEAR16",
            sampleRateHertz: 16_000,
            audioChannelCount: 1
          },
          languageCodes: ["ko-KR"],
          model: "chirp_3",
          features: { enableAutomaticPunctuation: true }
        },
        streamingFeatures: {
          interimResults: true,
          enableVoiceActivityEvents: true,
          endpointingSensitivity
        }
      }
    });
  });

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

  it("50개 원본 용어에 추가된 발음 표기를 50번째 이후에도 전달한다", () => {
    const phraseSet = Array.from({ length: 100 }, (_, index) => `Phrase ${index}`);

    const request = buildStreamingRecognizeRequest("project", "us", "chirp_3", phraseSet);
    const phrases = request.streamingConfig.config.adaptation?.phraseSets[0]?.inlinePhraseSet.phrases;

    expect(phrases).toHaveLength(100);
    expect(phrases?.[99]).toEqual({ value: "Phrase 99" });
  });

  it("PhraseSet이 비어 있으면 adaptation 설정을 보내지 않는다", () => {
    const request = buildStreamingRecognizeRequest("project", "us", "chirp_3", []);

    expect(request.streamingConfig.config).not.toHaveProperty("adaptation");
    expect(request.streamingConfig.streamingFeatures).toEqual({
      interimResults: true,
      enableVoiceActivityEvents: true,
      endpointingSensitivity:
        protos.google.cloud.speech.v2.StreamingRecognitionFeatures.EndpointingSensitivity
          .ENDPOINTING_SENSITIVITY_SHORT
    });
  });
});

describe("projectStreamingRecognizeResponse", () => {
  it("여러 interim 구간을 제공자 원문 경계 그대로 한 번의 업데이트로 합친다", () => {
    expect(
      projectStreamingRecognizeResponse({
        results: [
          { alternatives: [{ transcript: "  to be" }], isFinal: false },
          { alternatives: [{ transcript: " or not" }], isFinal: false },
          { alternatives: [{ transcript: " to be  " }], isFinal: false }
        ]
      })
    ).toEqual([{ text: "to be or not to be", isFinal: false }]);

    expect(
      projectStreamingRecognizeResponse({
        results: [
          { alternatives: [{ transcript: "실시간" }], isFinal: false },
          { alternatives: [{ transcript: "자막" }], isFinal: false }
        ]
      })
    ).toEqual([{ text: "실시간자막", isFinal: false }]);
  });

  it("새 final을 먼저 보내고 여러 interim 꼬리를 하나로 합쳐 뒤이어 보낸다", () => {
    expect(
      projectStreamingRecognizeResponse({
        results: [
          { alternatives: [{ transcript: "  확정 구간  " }], isFinal: true },
          { alternatives: [{ transcript: "새" }], isFinal: false },
          { alternatives: [{ transcript: " 임시 구간 " }], isFinal: false }
        ]
      })
    ).toEqual([
      { text: "확정 구간", isFinal: true },
      { text: "새 임시 구간", isFinal: false }
    ]);
  });

  it("여러 final prefix를 각자 정리해 순서대로 방출한다", () => {
    expect(
      projectStreamingRecognizeResponse({
        results: [
          { alternatives: [{ transcript: " 첫 번째 " }], isFinal: true },
          { alternatives: [{ transcript: " 두 번째 " }], isFinal: true },
          { alternatives: [{ transcript: "세 번째" }], isFinal: true }
        ]
      })
    ).toEqual([
      { text: "첫 번째", isFinal: true },
      { text: "두 번째", isFinal: true },
      { text: "세 번째", isFinal: true }
    ]);
  });

  it("공백·빈 transcript·첫 alternative 누락을 건너뛰고 유효한 interim만 한 번 보낸다", () => {
    expect(
      projectStreamingRecognizeResponse({
        results: [
          { alternatives: [{ transcript: "   " }], isFinal: true },
          { alternatives: [], isFinal: false },
          { isFinal: false },
          { alternatives: [{ transcript: "" }], isFinal: false },
          { alternatives: [{ transcript: " 유효" }], isFinal: false },
          { alternatives: [{ transcript: " interim " }], isFinal: false }
        ]
      })
    ).toEqual([{ text: "유효 interim", isFinal: false }]);

    expect(projectStreamingRecognizeResponse({ results: [] })).toEqual([]);
    expect(projectStreamingRecognizeResponse({})).toEqual([]);
  });

  it("연속 응답마다 interim 전체를 하나의 교체 단위로 만든다", () => {
    const responses = [
      {
        results: [
          { alternatives: [{ transcript: "오늘" }], isFinal: false },
          { alternatives: [{ transcript: " 날씨" }], isFinal: false }
        ]
      },
      {
        results: [
          { alternatives: [{ transcript: "오늘" }], isFinal: false },
          { alternatives: [{ transcript: " 날씨가" }], isFinal: false },
          { alternatives: [{ transcript: " 좋습니다" }], isFinal: false }
        ]
      }
    ];

    expect(responses.map((response) => projectStreamingRecognizeResponse(response))).toEqual([
      [{ text: "오늘 날씨", isFinal: false }],
      [{ text: "오늘 날씨가 좋습니다", isFinal: false }]
    ]);
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
  it("awaits one reusable client initialization before opening each stream", async () => {
    configureSupportedSpeech();
    const firstStream = new RecordingSpeechStream();
    const secondStream = new RecordingSpeechStream();
    let finishInitialization!: () => void;
    const initialization = new Promise<void>((resolve) => {
      finishInitialization = resolve;
    });
    const client = {
      initialize: vi.fn(() => initialization.then(() => ({}))),
      _streamingRecognize: vi.fn()
        .mockReturnValueOnce(firstStream)
        .mockReturnValueOnce(secondStream)
    } satisfies SpeechClientPort;

    const firstSessionPromise = createGoogleSpeechSession(
      [],
      { onTranscript: vi.fn(), onError: vi.fn(), onEnd: vi.fn() },
      { client }
    );
    await Promise.resolve();
    expect(client._streamingRecognize).not.toHaveBeenCalled();

    finishInitialization();
    const firstSession = await firstSessionPromise;
    const secondSession = await createGoogleSpeechSession(
      [],
      { onTranscript: vi.fn(), onError: vi.fn(), onEnd: vi.fn() },
      { client }
    );

    expect(client.initialize).toHaveBeenCalledTimes(1);
    expect(client._streamingRecognize).toHaveBeenCalledTimes(2);
    firstSession.finishInput();
    secondSession.finishInput();
  });

  it("does not open a stream when shared client initialization fails", async () => {
    configureSupportedSpeech();
    const client = {
      initialize: vi.fn(async () => {
        throw new Error("ADC initialization failed");
      }),
      _streamingRecognize: vi.fn()
    } satisfies SpeechClientPort;

    await expect(
      createGoogleSpeechSession([], { onTranscript: vi.fn(), onError: vi.fn(), onEnd: vi.fn() }, { client })
    ).rejects.toThrow("ADC initialization failed");
    expect(client._streamingRecognize).not.toHaveBeenCalled();
  });

  it("does not resolve readiness until the initialized stream accepts the config write", async () => {
    configureSupportedSpeech();
    const stream = new DelayedWriteSpeechStream();
    const client = createRecordingClient(stream);
    let resolved = false;

    const pendingSession = createGoogleSpeechSession(
      [],
      { onTranscript: vi.fn(), onError: vi.fn(), onEnd: vi.fn() },
      { client, readyTimeoutMs: 500 }
    ).then((session) => {
      resolved = true;
      return session;
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(stream.writes).toHaveLength(1);
    expect(resolved).toBe(false);

    stream.releaseWrite();
    await pendingSession;
    expect(resolved).toBe(true);
  });

  it("fails instead of deadlocking when the initial config write never becomes writable", async () => {
    vi.useFakeTimers();
    configureSupportedSpeech();
    const stream = new DelayedWriteSpeechStream();
    const client = createRecordingClient(stream);
    const onError = vi.fn();
    const pendingSession = createGoogleSpeechSession(
      [],
      { onTranscript: vi.fn(), onError, onEnd: vi.fn() },
      { client, readyTimeoutMs: 50 }
    );
    const rejection = expect(pendingSession).rejects.toThrow("초기 설정 전송 시간이 초과");

    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("첫 write에 recognizer와 전체 설정을 변형 없이 보내고 typed V2 bidi 메서드를 사용한다", async () => {
    configureSupportedSpeech();
    const stream = new RecordingSpeechStream();
    const client = createRecordingClient(stream);
    const expected = buildStreamingRecognizeRequest("project", "us", "chirp_3", ["RAG"]);

    await createGoogleSpeechSession(
      ["RAG"],
      { onTranscript: vi.fn(), onError: vi.fn(), onEnd: vi.fn() },
      { client }
    );

    expect(client._streamingRecognize).toHaveBeenCalledTimes(1);
    expect(stream.writes).toEqual([expected]);
    expect(stream.writes[0]).not.toHaveProperty("audio");
    expect(stream.writes[0]).not.toHaveProperty("audioContent");
  });

  it("후속 write에는 15KB 이하 audio만 보내고 audioContent로 감싸지 않는다", async () => {
    configureSupportedSpeech();
    const stream = new RecordingSpeechStream();
    const client = createRecordingClient(stream);
    const onError = vi.fn();
    const onEnd = vi.fn();
    const session = await createGoogleSpeechSession(
      [],
      { onTranscript: vi.fn(), onError, onEnd },
      { client }
    );
    const acceptedAudio = Buffer.alloc(15_000, 1);

    expect(session.enqueueAudio(acceptedAudio)).toBe("accepted");
    expect(session.enqueueAudio(Buffer.alloc(15_001, 2))).toBe("closed");

    expect(stream.writes).toHaveLength(2);
    expect(stream.writes[1]).toEqual({ audio: acceptedAudio });
    expect(stream.writes[1]).not.toHaveProperty("audioContent");
    expect(stream.writes[1]).not.toHaveProperty("recognizer");
    expect(stream.writes[1]).not.toHaveProperty("streamingConfig");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("15KB") }));
    expect(onEnd).not.toHaveBeenCalled();

    stream.emit("end");
    stream.emit("close");
    expect(session.enqueueAudio(Buffer.from([1, 2]))).toBe("closed");

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
    expect(stream.writes).toHaveLength(2);
  });

  it("V2 응답마다 합친 interim을 한 번 보내고 다음 final로 즉시 교체한다", async () => {
    configureSupportedSpeech();
    const stream = new RecordingSpeechStream();
    const client = createRecordingClient(stream);
    const onTranscript = vi.fn();

    await createGoogleSpeechSession(
      [],
      { onTranscript, onError: vi.fn(), onEnd: vi.fn() },
      { client }
    );
    stream.emit("data", {
      results: [
        { alternatives: [{ transcript: "임시" }], isFinal: false },
        { alternatives: [{ transcript: " 자막" }], isFinal: false }
      ]
    });
    stream.emit("data", {
      results: [
        { alternatives: [{ transcript: "임시" }], isFinal: false },
        { alternatives: [{ transcript: " 자막이" }], isFinal: false },
        { alternatives: [{ transcript: " 늘어남" }], isFinal: false }
      ]
    });
    stream.emit("data", {
      results: [{ alternatives: [{ transcript: "확정 자막" }], isFinal: true }]
    });

    expect(onTranscript).toHaveBeenNthCalledWith(1, "임시 자막", false);
    expect(onTranscript).toHaveBeenNthCalledWith(2, "임시 자막이 늘어남", false);
    expect(onTranscript).toHaveBeenNthCalledWith(3, "확정 자막", true);
    expect(onTranscript).toHaveBeenCalledTimes(3);
  });

  it("propagates gRPC backpressure and drain without dropping the accepted chunk", async () => {
    configureSupportedSpeech();
    const stream = new RecordingSpeechStream();
    const client = createRecordingClient(stream);
    const onDrain = vi.fn();
    const session = await createGoogleSpeechSession(
      [],
      { onTranscript: vi.fn(), onError: vi.fn(), onEnd: vi.fn(), onDrain },
      { client }
    );
    const originalWrite = stream.write.bind(stream);
    vi.spyOn(stream, "write").mockImplementation(((value: unknown, callback?: (error?: Error | null) => void) => {
      originalWrite(value, callback);
      return false;
    }) as typeof stream.write);

    expect(session.enqueueAudio(Buffer.alloc(3_200))).toBe("backpressure");
    expect(stream.writes.at(-1)).toEqual({ audio: Buffer.alloc(3_200) });

    stream.emit("drain");
    expect(onDrain).toHaveBeenCalledTimes(1);
  });

  it("emits VAD and first-result diagnostics containing metadata only", async () => {
    configureSupportedSpeech();
    const stream = new RecordingSpeechStream();
    const client = createRecordingClient(stream);
    const records: Array<Record<string, unknown>> = [];
    const onDiagnostic = createDevelopmentSpeechDiagnosticReporter(true, "session-test", (record) => records.push(record));
    const session = await createGoogleSpeechSession(
      [],
      { onTranscript: vi.fn(), onError: vi.fn(), onEnd: vi.fn(), onDiagnostic },
      { client }
    );

    session.enqueueAudio(Buffer.alloc(3_200));
    stream.emit("data", { speechEventType: 2 });
    stream.emit("data", { results: [{ alternatives: [{ transcript: "민감한 원문" }], isFinal: false }] });
    stream.emit("data", { results: [{ alternatives: [{ transcript: "민감한 확정 원문" }], isFinal: true }] });
    stream.emit("data", { speechEventType: "SPEECH_ACTIVITY_END" });

    expect(records.map((record) => record.stage)).toEqual([
      "client-initialized",
      "config-written",
      "first-pcm",
      "vad-begin",
      "first-interim",
      "first-final",
      "vad-end"
    ]);
    expect(Object.keys(records[0] ?? {}).sort()).toEqual([
      "elapsedMs",
      "pcmBytes",
      "pcmChunkCount",
      "sessionId",
      "stage"
    ]);
    expect(JSON.stringify(records)).not.toMatch(/민감|transcript|rawText|term|project|device|amplitude/i);
    expect(createDevelopmentSpeechDiagnosticReporter(false, "unused", vi.fn())).toBeUndefined();
  });

  it("명시적 close 후 지연된 final을 받은 뒤 readable end에서만 세션을 닫는다", async () => {
    configureSupportedSpeech();
    const stream = new RecordingSpeechStream();
    const client = createRecordingClient(stream);
    const events: string[] = [];
    const end = vi.spyOn(stream, "end");
    const session = await createGoogleSpeechSession(
      [],
      {
        onTranscript: (_text, isFinal) => events.push(isFinal ? "final" : "interim"),
        onError: () => events.push("error"),
        onEnd: () => events.push("end")
      },
      { client, drainTimeoutMs: 100 }
    );

    session.finishInput();
    session.finishInput();
    expect(session.enqueueAudio(Buffer.from([1, 2]))).toBe("closed");

    expect(end).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    expect(stream.writes).toHaveLength(1);

    stream.emit("data", {
      results: [{ alternatives: [{ transcript: "마지막 확정 자막" }], isFinal: true }]
    });
    stream.emit("end");
    stream.emit("close");
    stream.emit("error", new Error("late error"));

    expect(events).toEqual(["final", "end"]);
  });

  it("스트림 error 뒤 end와 close가 와도 onError만 한 번 호출한다", async () => {
    configureSupportedSpeech();
    const stream = new RecordingSpeechStream();
    const client = createRecordingClient(stream);
    const onError = vi.fn();
    const onEnd = vi.fn();
    const session = await createGoogleSpeechSession(
      [],
      { onTranscript: vi.fn(), onError, onEnd },
      { client }
    );

    stream.emit("error", new Error("transport failed"));
    stream.emit("end");
    stream.emit("close");
    expect(session.enqueueAudio(Buffer.from([1, 2]))).toBe("closed");

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
    expect(stream.writes).toHaveLength(1);
  });

  it("readable 종료가 없으면 제한 시간 뒤 한 번만 정상 종료하고 강제 정리한다", async () => {
    vi.useFakeTimers();
    configureSupportedSpeech();
    const stream = new RecordingSpeechStream();
    const client = createRecordingClient(stream);
    const onError = vi.fn();
    const onEnd = vi.fn();
    const session = await createGoogleSpeechSession(
      [],
      { onTranscript: vi.fn(), onError, onEnd },
      { client, drainTimeoutMs: 50 }
    );

    session.finishInput();
    await vi.advanceTimersByTimeAsync(49);

    await vi.advanceTimersByTimeAsync(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();

    stream.emit("end");
    stream.emit("close");
    stream.emit("error", new Error("after timeout"));
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("abort는 final drain을 기다리지 않고 provider stream을 즉시 취소한다", async () => {
    configureSupportedSpeech();
    const stream = new RecordingSpeechStream();
    const client = createRecordingClient(stream);
    const cancel = vi.spyOn(stream, "cancel");
    const onError = vi.fn();
    const onEnd = vi.fn();
    const session = await createGoogleSpeechSession(
      [],
      { onTranscript: vi.fn(), onError, onEnd },
      { client }
    );

    session.abort(new Error("client disconnected"));
    session.abort();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(session.enqueueAudio(Buffer.from([1, 2]))).toBe("closed");
    expect(onError).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
  });

});

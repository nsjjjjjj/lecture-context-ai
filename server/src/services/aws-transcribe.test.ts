import type {
  StartStreamTranscriptionCommand,
  StartStreamTranscriptionCommandOutput,
  TranscriptResultStream
} from "@aws-sdk/client-transcribe-streaming";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAwsStreamingRequest,
  createAwsTranscribeSession,
  findAwsStablePrefixLength,
  projectAwsResult,
  type AwsTranscribeStreamingPort
} from "./aws-transcribe.js";

function output(stream: AsyncIterable<TranscriptResultStream>): StartStreamTranscriptionCommandOutput {
  return { $metadata: { requestId: "request-1" }, SessionId: "session-1", TranscriptResultStream: stream };
}

async function* streamOf(...members: TranscriptResultStream[]): AsyncIterable<TranscriptResultStream> {
  for (const member of members) yield member;
}

function configuration(overrides: Partial<{ providerTimeoutMs: number; drainTimeoutMs: number }> = {}) {
  return {
    region: "ap-northeast-2",
    partialResultsStability: "low" as const,
    providerTimeoutMs: 8_000,
    drainTimeoutMs: 5_000,
    ...overrides
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AWS Transcribe request", () => {
  it("16kHz mono PCM, ko-KR, partial 안정화와 용어집을 지정한다", () => {
    const audioStream = streamOf();
    expect(buildAwsStreamingRequest(audioStream, "medium", "lecture-ko-hash")).toMatchObject({
      LanguageCode: "ko-KR",
      MediaEncoding: "pcm",
      MediaSampleRateHertz: 16_000,
      EnablePartialResultsStabilization: true,
      PartialResultsStability: "medium",
      VocabularyName: "lecture-ko-hash",
      AudioStream: audioStream
    });
  });

  it("stability off이면 안정화 필드를 전송하지 않는다", () => {
    const request = buildAwsStreamingRequest(streamOf(), "off");
    expect(request).not.toHaveProperty("EnablePartialResultsStabilization");
    expect(request).not.toHaveProperty("PartialResultsStability");
    expect(request).not.toHaveProperty("VocabularyName");
  });
});

describe("AWS transcript projection", () => {
  it("AWS result id, 시간, partial stable prefix를 보존한다", () => {
    expect(
      projectAwsResult({
        ResultId: "result-1",
        IsPartial: true,
        StartTime: 1.234,
        EndTime: 2.5,
        Alternatives: [
          {
            Transcript: "검색 증강 생성",
            Items: [
              { Content: "검색", Stable: true },
              { Content: "증강", Stable: true },
              { Content: "생성", Stable: false }
            ]
          }
        ]
      })
    ).toEqual({
      text: "검색 증강 생성",
      isFinal: false,
      providerResultId: "result-1",
      stablePrefixLength: 5,
      startTimeMs: 1_234,
      endTimeMs: 2_500
    });
  });

  it("첫 unstable item에서 stable prefix 계산을 멈춘다", () => {
    expect(
      findAwsStablePrefixLength("RAG를 설명합니다.", [
        { Content: "RAG", Stable: true },
        { Content: "를", Stable: false },
        { Content: "설명합니다", Stable: true }
      ])
    ).toBe(3);
  });
});

describe("AWS transcription session", () => {
  it("세션을 즉시 만들고 provider 응답 이후 accepted 신호와 자막을 보낸다", async () => {
    let resolveSend: ((value: StartStreamTranscriptionCommandOutput) => void) | undefined;
    const client: AwsTranscribeStreamingPort = {
      send: vi.fn(
        () =>
          new Promise<StartStreamTranscriptionCommandOutput>((resolve) => {
            resolveSend = resolve;
          })
      )
    };
    const onProviderAccepted = vi.fn();
    const onTranscript = vi.fn();
    const session = createAwsTranscribeSession(
      undefined,
      { onProviderAccepted, onTranscript, onError: vi.fn(), onEnd: vi.fn() },
      { client, configuration: configuration() }
    );

    expect(session.enqueueAudio(Buffer.alloc(3_200))).toBe("accepted");
    expect(onProviderAccepted).not.toHaveBeenCalled();
    resolveSend?.(
      output(
        streamOf({
          TranscriptEvent: {
            Transcript: {
              Results: [{ ResultId: "one", IsPartial: false, Alternatives: [{ Transcript: "확정 문장" }] }]
            }
          }
        })
      )
    );
    await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledWith(expect.objectContaining({ text: "확정 문장" })));
    expect(onProviderAccepted).toHaveBeenCalledWith({ requestId: "request-1", sessionId: "session-1" });
  });

  it("finishInput 뒤의 늦은 final을 받고 스트림 종료 후 끝낸다", async () => {
    let releaseFinal: (() => void) | undefined;
    const finalGate = new Promise<void>((resolve) => {
      releaseFinal = resolve;
    });
    const delayedStream = async function* (): AsyncIterable<TranscriptResultStream> {
      await finalGate;
      yield {
        TranscriptEvent: {
          Transcript: { Results: [{ IsPartial: false, Alternatives: [{ Transcript: "마지막 확정" }] }] }
        }
      };
    };
    const onTranscript = vi.fn();
    const onEnd = vi.fn();
    const session = createAwsTranscribeSession(
      undefined,
      { onProviderAccepted: vi.fn(), onTranscript, onError: vi.fn(), onEnd },
      { client: { send: vi.fn(async () => output(delayedStream())) }, configuration: configuration() }
    );

    session.finishInput();
    expect(onEnd).not.toHaveBeenCalled();
    releaseFinal?.();
    await vi.waitFor(() => expect(onEnd).toHaveBeenCalledWith({ flushTimedOut: false }));
    expect(onTranscript).toHaveBeenCalledWith(expect.objectContaining({ text: "마지막 확정", isFinal: true }));
  });

  it("local finishInput 전 provider EOF는 completed가 아니라 transport error다", async () => {
    const onError = vi.fn();
    const onEnd = vi.fn();
    const session = createAwsTranscribeSession(
      undefined,
      { onProviderAccepted: vi.fn(), onTranscript: vi.fn(), onError, onEnd },
      { client: { send: vi.fn(async () => output(streamOf())) }, configuration: configuration() }
    );

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("입력 종료 전에 예상치 못하게 종료") })
    ));
    expect(onEnd).not.toHaveBeenCalled();
    expect(session.enqueueAudio(Buffer.alloc(10))).toBe("closed");
  });

  it("drain 제한시간이 지나면 final 누락 가능성을 표시하고 끝낸다", async () => {
    vi.useFakeTimers();
    const neverEnding = async function* (): AsyncIterable<TranscriptResultStream> {
      await new Promise(() => undefined);
    };
    const onEnd = vi.fn();
    const session = createAwsTranscribeSession(
      undefined,
      { onProviderAccepted: vi.fn(), onTranscript: vi.fn(), onError: vi.fn(), onEnd },
      { client: { send: vi.fn(async () => output(neverEnding())) }, configuration: configuration({ drainTimeoutMs: 50 }) }
    );

    session.finishInput();
    await vi.advanceTimersByTimeAsync(50);
    expect(onEnd).toHaveBeenCalledWith({ flushTimedOut: true });
  });

  it("첫 PCM 뒤 provider 응답 제한시간이 지나면 명시적으로 실패한다", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const session = createAwsTranscribeSession(
      undefined,
      { onProviderAccepted: vi.fn(), onTranscript: vi.fn(), onError, onEnd: vi.fn() },
      {
        client: { send: vi.fn(async () => new Promise<StartStreamTranscriptionCommandOutput>(() => undefined)) },
        configuration: configuration({ providerTimeoutMs: 40 })
      }
    );

    session.enqueueAudio(Buffer.alloc(3_200));
    await vi.advanceTimersByTimeAsync(40);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("준비 시간이 초과") }));
    expect(session.enqueueAudio(Buffer.alloc(10))).toBe("closed");
  });

  it("명시적 abort는 사용자 콜백 없이 요청을 중단한다", async () => {
    const onError = vi.fn();
    const onEnd = vi.fn();
    let command: StartStreamTranscriptionCommand | undefined;
    const client: AwsTranscribeStreamingPort = {
      send: vi.fn(async (received) => {
        command = received;
        await new Promise(() => undefined);
        return output(streamOf());
      })
    };
    const session = createAwsTranscribeSession(
      undefined,
      { onProviderAccepted: vi.fn(), onTranscript: vi.fn(), onError, onEnd },
      { client, configuration: configuration() }
    );

    session.abort(new Error("socket closed"));
    await Promise.resolve();
    expect(command).toBeDefined();
    expect(onError).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
    expect(session.enqueueAudio(Buffer.alloc(10))).toBe("closed");
  });
});

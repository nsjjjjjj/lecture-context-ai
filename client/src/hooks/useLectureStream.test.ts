import { describe, expect, it, vi } from "vitest";
import {
  beginLiveStopRequest,
  createCaptionReceiveToAfterPaintEstimator,
  createDevelopmentCaptionReceiveToAfterPaintEstimator,
  createDevelopmentLiveClientDiagnostics,
  createFinalTranscriptLine,
  forwardLiveAudioChunk,
  handleSocketTransportFailure,
  LIVE_AUDIO_MAX_BUFFERED_BYTES,
  LIVE_AUDIO_MAX_BUFFERED_LAG_MS,
  LIVE_CAPTURE_READY_TIMEOUT_MS,
  resolveMissingLiveStopRequestDisposition,
  resolveLiveReadiness,
  resolveSocketTransportFailureDisposition,
  sendLiveAudioChunk
} from "./useLectureStream";

describe("useLectureStream live readiness and bounded audio transport", () => {
  it("declares ready only after provider config and the first PCM are both ready", () => {
    expect(resolveLiveReadiness({ providerReady: false, captureReady: false })).toEqual({
      ready: false,
      message: "마이크와 Google STT를 연결하고 있습니다."
    });
    expect(resolveLiveReadiness({ providerReady: true, captureReady: false })).toEqual({
      ready: false,
      message: "마이크 입력을 확인하고 있습니다."
    });
    expect(resolveLiveReadiness({ providerReady: false, captureReady: true })).toEqual({
      ready: false,
      message: "Google STT 전송을 준비하고 있습니다."
    });
    expect(resolveLiveReadiness({ providerReady: true, captureReady: true })).toEqual({
      ready: true,
      message: "마이크와 Google STT가 준비되었습니다."
    });
  });

  it("derives a 0.5 second browser high-water mark from the PCM byte rate", () => {
    expect(LIVE_AUDIO_MAX_BUFFERED_LAG_MS).toBe(500);
    expect(LIVE_AUDIO_MAX_BUFFERED_BYTES).toBe(16_000);
    expect(LIVE_CAPTURE_READY_TIMEOUT_MS).toBe(3_000);
  });

  it("sends within the bound and rejects projected stale backlog without adding another chunk", () => {
    const send = vi.fn();
    const audio = new ArrayBuffer(3_200);

    expect(sendLiveAudioChunk({ readyState: WebSocket.OPEN, bufferedAmount: 12_000, send }, audio)).toBe("sent");
    expect(send).toHaveBeenCalledWith(audio);

    send.mockClear();
    expect(sendLiveAudioChunk({ readyState: WebSocket.OPEN, bufferedAmount: 13_000, send }, audio)).toBe(
      "backpressure"
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("does not forward any PCM before the provider-ready handshake", () => {
    const send = vi.fn();
    const socket = { readyState: WebSocket.OPEN, bufferedAmount: 0, send };
    const audio = new ArrayBuffer(3_200);

    expect(forwardLiveAudioChunk(false, socket, audio)).toBe("preparing");
    expect(send).not.toHaveBeenCalled();

    expect(forwardLiveAudioChunk(true, socket, audio)).toBe("sent");
    expect(send).toHaveBeenCalledWith(audio);
  });

  it("turns unavailable and throwing WebSocket sends into explicit failure results", () => {
    expect(
      sendLiveAudioChunk({ readyState: WebSocket.CLOSING, bufferedAmount: 0, send: vi.fn() }, new ArrayBuffer(8))
    ).toBe("unavailable");
    expect(
      sendLiveAudioChunk(
        {
          readyState: WebSocket.OPEN,
          bufferedAmount: 0,
          send: () => {
            throw new Error("socket closed");
          }
        },
        new ArrayBuffer(8)
      )
    ).toBe("send-error");
  });

  it("keeps development diagnostics to timing and counters only", () => {
    let nowMs = 100;
    const reports: Array<Record<string, unknown>> = [];
    const diagnostics = createDevelopmentLiveClientDiagnostics(true, {
      sessionId: "session-test",
      now: () => nowMs,
      reporter: (record) => reports.push(record)
    });

    diagnostics?.mark("websocket-open");
    nowMs = 180;
    diagnostics?.recordPcm(3_200, 120);
    nowMs = 270;
    diagnostics?.recordPcm(3_200, 240);
    diagnostics?.mark("first-interim");

    expect(reports.map((record) => record.stage)).toEqual(["websocket-open", "first-pcm", "first-interim"]);
    expect(reports.at(-1)).toEqual({
      sessionId: "session-test",
      stage: "first-interim",
      elapsedMs: 170,
      pcmChunkCount: 2,
      pcmBytes: 6_400,
      maxInterchunkGapMs: 90,
      maxWebSocketBufferedAmount: 240
    });
    expect(Object.keys(reports.at(-1) ?? {}).sort()).toEqual([
      "elapsedMs",
      "maxInterchunkGapMs",
      "maxWebSocketBufferedAmount",
      "pcmBytes",
      "pcmChunkCount",
      "sessionId",
      "stage"
    ]);
    expect(JSON.stringify(reports)).not.toMatch(/transcript|rawText|term|project|device|amplitude|content/i);
    expect(
      createDevelopmentLiveClientDiagnostics(false, {
        sessionId: "unused",
        now: vi.fn(),
        reporter: vi.fn()
      })
    ).toBeNull();
  });
});

describe("useLectureStream development caption paint estimate", () => {
  it("schedules rAF then a task, assigns distinct sequences, and reports timing metadata only", () => {
    let nowMs = 100;
    const animationFrames: Array<() => void> = [];
    const afterFrameTasks: Array<() => void> = [];
    const schedulingMarkers: string[] = [];
    const reports: Array<Record<string, unknown>> = [];
    const estimator = createCaptionReceiveToAfterPaintEstimator({
      requestAnimationFrame: (callback) => {
        schedulingMarkers.push("raf:scheduled");
        animationFrames.push(() => {
          schedulingMarkers.push("raf:run");
          callback();
        });
      },
      scheduleAfterFrameTask: (callback) => {
        schedulingMarkers.push("task:scheduled");
        afterFrameTasks.push(() => {
          schedulingMarkers.push("task:run");
          callback();
        });
      },
      now: () => nowMs,
      reporter: (estimate) => reports.push(estimate)
    });

    expect(estimator.markReceived("interim")).toBe(1);
    nowMs = 101;
    expect(estimator.markReceived("final")).toBe(2);
    expect(schedulingMarkers).toEqual(["raf:scheduled", "raf:scheduled"]);
    expect(reports).toEqual([]);

    nowMs = 102;
    animationFrames.shift()?.();
    nowMs = 103;
    animationFrames.shift()?.();
    expect(schedulingMarkers).toEqual([
      "raf:scheduled",
      "raf:scheduled",
      "raf:run",
      "task:scheduled",
      "raf:run",
      "task:scheduled"
    ]);

    nowMs = 110;
    afterFrameTasks.shift()?.();
    nowMs = 114;
    afterFrameTasks.shift()?.();

    expect(reports).toEqual([
      {
        sequenceId: 1,
        eventKind: "interim",
        receivedAtMs: 100,
        afterPaintEstimateAtMs: 110,
        receiveToAfterPaintEstimateMs: 10
      },
      {
        sequenceId: 2,
        eventKind: "final",
        receivedAtMs: 101,
        afterPaintEstimateAtMs: 114,
        receiveToAfterPaintEstimateMs: 13
      }
    ]);
    expect(Object.keys(reports[0] ?? {}).sort()).toEqual([
      "afterPaintEstimateAtMs",
      "eventKind",
      "receiveToAfterPaintEstimateMs",
      "receivedAtMs",
      "sequenceId"
    ]);
    expect(JSON.stringify(reports)).not.toMatch(/transcript|audio|content|text/i);
    expect(schedulingMarkers).toEqual([
      "raf:scheduled",
      "raf:scheduled",
      "raf:run",
      "task:scheduled",
      "raf:run",
      "task:scheduled",
      "task:run",
      "task:run"
    ]);
  });

  it("does not create the estimator outside development", () => {
    const options = {
      requestAnimationFrame: vi.fn(),
      scheduleAfterFrameTask: vi.fn(),
      now: vi.fn(() => 0),
      reporter: vi.fn()
    };

    expect(createDevelopmentCaptionReceiveToAfterPaintEstimator(false, options)).toBeNull();
    expect(options.requestAnimationFrame).not.toHaveBeenCalled();
    expect(options.scheduleAfterFrameTask).not.toHaveBeenCalled();
    expect(options.now).not.toHaveBeenCalled();
    expect(options.reporter).not.toHaveBeenCalled();
  });
});

describe("useLectureStream final transcript mapping", () => {
  it("자막 termIds는 고유하게 유지하고 피드용 occurrence 목록은 반복을 보존한다", () => {
    const result = createFinalTranscriptLine(
      {
        type: "final",
        text: "RAG와 다시 RAG",
        detectedTerms: ["rag", "rag"],
        relatedPage: 3
      },
      "line-rag"
    );

    expect(result.line).toEqual({
      id: "line-rag",
      text: "RAG와 다시 RAG",
      rawText: "RAG와 다시 RAG",
      termIds: ["rag"],
      relatedPage: 3,
      corrections: []
    });
    expect(result.occurrenceTermIds).toEqual(["rag", "rag"]);
  });

  it("정정된 표시 자막과 원본 STT·정정 근거를 함께 보존한다", () => {
    const correction = {
      originalText: "레그",
      correctedText: "RAG",
      termId: "rag",
      displayStart: 0,
      displayEnd: 3,
      reason: "spokenAlias" as const
    };
    const result = createFinalTranscriptLine({
      type: "final",
      text: "RAG를 설명합니다.",
      rawText: "레그를 설명합니다.",
      detectedTerms: ["rag"],
      corrections: [correction]
    }, "line-corrected");

    expect(result.line).toMatchObject({
      text: "RAG를 설명합니다.",
      rawText: "레그를 설명합니다.",
      corrections: [correction]
    });
  });
});

describe("useLectureStream live stop ordering", () => {
  it("recorder가 완전히 멈춘 뒤 wait를 등록하고 stop 메시지를 보낸다", async () => {
    const events: string[] = [];
    let finishRecorderStop!: () => void;
    const stopRecorder = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          events.push("recorder-stop-start");
          finishRecorderStop = () => {
            events.push("recorder-stop-end");
            resolve();
          };
        })
    );
    const waitForServer = new Promise<void>(() => undefined);
    const operation = beginLiveStopRequest(
      stopRecorder,
      () => true,
      () => {
        events.push("wait-registered");
        return waitForServer;
      },
      () => events.push("stop-sent")
    );

    await Promise.resolve();
    expect(events).toEqual(["recorder-stop-start"]);

    finishRecorderStop();
    const request = await operation;

    expect(request?.waitForServer).toBe(waitForServer);
    expect(events).toEqual(["recorder-stop-start", "recorder-stop-end", "wait-registered", "stop-sent"]);
  });

  it("restart로 세션 소유권이 바뀌면 stop 메시지를 보내지 않는다", async () => {
    const prepareWait = vi.fn(() => Promise.resolve());
    const sendStop = vi.fn();

    const request = await beginLiveStopRequest(async () => undefined, () => false, prepareWait, sendStop);

    expect(request).toBeNull();
    expect(prepareWait).not.toHaveBeenCalled();
    expect(sendStop).not.toHaveBeenCalled();
  });

  it("server ended 대기 중 socket close를 불완전 종료 error로 판정하고 gate를 해제한다", () => {
    expect(resolveSocketTransportFailureDisposition("close", true)).toEqual({
      status: "error",
      message: "강연 종료 중 자막 연결이 끊어졌습니다. 마지막 자막이 모두 반영되지 않았을 수 있습니다.",
      completeStopGate: true
    });
  });

  it("일반 socket close도 error지만 stop gate는 건드리지 않는다", () => {
    expect(resolveSocketTransportFailureDisposition("close", false)).toEqual({
      status: "error",
      message: "자막 연결이 예기치 않게 종료되었습니다.",
      completeStopGate: false
    });
  });

  it("stop 대기 중 onerror가 shutdown/error/gate complete를 한 번 수행하고 뒤이은 close는 무시한다", () => {
    const events: string[] = [];
    let current = true;
    const options = {
      isWaitingForServerEnd: true,
      isCurrent: () => current,
      shutDown: () => {
        events.push("shutdown");
        current = false;
      },
      dispatchError: (message: string) => events.push(`error:${message}`),
      completeStopGate: () => events.push("gate-complete")
    };

    expect(handleSocketTransportFailure({ ...options, source: "error" })).toBe(true);
    expect(handleSocketTransportFailure({ ...options, source: "close" })).toBe(false);
    expect(events).toEqual([
      "shutdown",
      "error:강연 종료 중 자막 연결이 끊어졌습니다. 마지막 자막이 모두 반영되지 않았을 수 있습니다.",
      "gate-complete"
    ]);
  });

  it("recorder stop 대기 중 transport failure가 나면 null continuation이 기존 error를 ended로 덮지 않는다", async () => {
    const events: string[] = [];
    let ownsSocket = true;
    let finishRecorderStop!: () => void;
    const operation = beginLiveStopRequest(
      () =>
        new Promise<void>((resolve) => {
          events.push("recorder-stop-start");
          finishRecorderStop = resolve;
        }),
      () => ownsSocket,
      () => Promise.resolve(),
      () => events.push("stop-sent")
    );

    await Promise.resolve();
    handleSocketTransportFailure({
      source: "error",
      isWaitingForServerEnd: false,
      isCurrent: () => ownsSocket,
      shutDown: () => {
        ownsSocket = false;
        events.push("shutdown");
      },
      dispatchError: (message) => events.push(`error:${message}`),
      completeStopGate: () => events.push("gate-complete")
    });
    finishRecorderStop();

    const request = await operation;
    const continuation = resolveMissingLiveStopRequestDisposition(!ownsSocket);
    if (continuation) events.push(continuation.status);

    expect(request).toBeNull();
    expect(continuation).toBeNull();
    expect(events).toEqual(["recorder-stop-start", "shutdown", "error:서버에 연결하지 못했습니다."]);
    expect(events).not.toContain("ended");
  });

  it("같은 generation에서 terminal handler 없이 request가 null이면 불완전 종료 error만 반환한다", () => {
    expect(resolveMissingLiveStopRequestDisposition(false)).toEqual({
      status: "error",
      message: "강연 종료 중 자막 연결이 끊어졌습니다. 마지막 자막이 모두 반영되지 않았을 수 있습니다.",
      completeStopGate: false
    });
  });
});

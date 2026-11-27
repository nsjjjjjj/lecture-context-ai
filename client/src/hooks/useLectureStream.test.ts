import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginLiveStopRequest,
  createFinalTranscriptLine,
  createLectureWebSocket
} from "./useLectureStream";
import {
  createLectureSessionDeadlineController,
  LIVE_CAPTURE_PERMISSION_TIMEOUT_MS,
  LIVE_FIRST_PCM_TIMEOUT_MS,
  LIVE_SOCKET_OPEN_TIMEOUT_MS,
  LIVE_START_HANDSHAKE_TIMEOUT_MS
} from "./lecture-session-deadlines";
import {
  createPreReadyPcmQueue,
  forwardLiveAudioChunk,
  LIVE_AUDIO_MAX_BUFFERED_BYTES,
  LIVE_AUDIO_MAX_BUFFERED_LAG_MS,
  sendLiveAudioChunk
} from "./live-audio-transport";
import {
  createLiveClientHandshakeState,
  resolveLiveHandshakeView,
  transitionLiveClientHandshake,
  type LiveClientHandshakeEvent,
  type LiveClientHandshakeState
} from "./live-client-handshake";
import {
  createCaptionReceiveToAfterPaintEstimator,
  createDevelopmentCaptionReceiveToAfterPaintEstimator,
  createDevelopmentLiveClientDiagnostics,
  handleSocketTransportFailure,
  resolveMissingLiveStopRequestDisposition,
  resolveSocketTransportFailureDisposition
} from "./lecture-stream-diagnostics";

afterEach(() => {
  vi.useRealTimers();
});

describe("useLectureStream session deadlines", () => {
  it("times out a half-open WebSocket only while the same session still owns the deadline", async () => {
    vi.useFakeTimers();
    const controller = createLectureSessionDeadlineController();
    const socket = {};
    const onTimeout = vi.fn();

    controller.arm("socket-open", socket, 7, LIVE_SOCKET_OPEN_TIMEOUT_MS, onTimeout);
    await vi.advanceTimersByTimeAsync(LIVE_SOCKET_OPEN_TIMEOUT_MS - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(onTimeout).toHaveBeenCalledOnce();
    expect(controller.clear("socket-open", socket, 7)).toBe(false);
  });

  it("clears the open phase on success and independently bounds the start handshake", async () => {
    vi.useFakeTimers();
    const controller = createLectureSessionDeadlineController();
    const socket = {};
    const openTimedOut = vi.fn();
    const handshakeTimedOut = vi.fn();

    controller.arm("socket-open", socket, 2, LIVE_SOCKET_OPEN_TIMEOUT_MS, openTimedOut);
    expect(controller.clear("socket-open", socket, 2)).toBe(true);
    controller.arm("start-handshake", socket, 2, LIVE_START_HANDSHAKE_TIMEOUT_MS, handshakeTimedOut);
    await vi.advanceTimersByTimeAsync(LIVE_START_HANDSHAKE_TIMEOUT_MS);

    expect(openTimedOut).not.toHaveBeenCalled();
    expect(handshakeTimedOut).toHaveBeenCalledOnce();
  });

  it("successful handshake, stop, and unmount-style clearAll prevent every late timeout", async () => {
    vi.useFakeTimers();
    const controller = createLectureSessionDeadlineController();
    const socket = {};
    const onTimeout = vi.fn();

    controller.arm("start-handshake", socket, 4, LIVE_START_HANDSHAKE_TIMEOUT_MS, onTimeout);
    expect(controller.clear("start-handshake", socket, 4)).toBe(true);
    controller.arm("capture-permission", socket, 4, LIVE_CAPTURE_PERMISSION_TIMEOUT_MS, onTimeout);
    controller.arm("first-pcm", socket, 4, LIVE_FIRST_PCM_TIMEOUT_MS, onTimeout);
    expect(controller.clearSession(socket, 4)).toBe(2);
    controller.arm("socket-open", socket, 4, LIVE_SOCKET_OPEN_TIMEOUT_MS, onTimeout);
    expect(controller.clearAll()).toBe(1);
    await vi.runAllTimersAsync();

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("an old session cleanup cannot clear a restarted session's deadline", async () => {
    vi.useFakeTimers();
    const controller = createLectureSessionDeadlineController();
    const oldSocket = {};
    const newSocket = {};
    const oldTimeout = vi.fn();
    const newTimeout = vi.fn();

    controller.arm("socket-open", oldSocket, 1, LIVE_SOCKET_OPEN_TIMEOUT_MS, oldTimeout);
    controller.arm("socket-open", newSocket, 2, LIVE_SOCKET_OPEN_TIMEOUT_MS, newTimeout);
    expect(controller.clearSession(oldSocket, 1)).toBe(0);
    await vi.advanceTimersByTimeAsync(LIVE_SOCKET_OPEN_TIMEOUT_MS);

    expect(oldTimeout).not.toHaveBeenCalled();
    expect(newTimeout).toHaveBeenCalledOnce();
  });
});

describe("useLectureStream live readiness and bounded audio transport", () => {
  it("turns a synchronous WebSocket construction failure into data instead of throwing", () => {
    const create = vi.fn(() => {
      throw new Error("invalid WebSocket URL");
    });

    expect(createLectureWebSocket("ws://invalid.test/ws", create)).toEqual({ ok: false });
    expect(create).toHaveBeenCalledWith("ws://invalid.test/ws");
  });

  it("returns the constructed WebSocket on the successful path", () => {
    const socket = {} as WebSocket;
    expect(createLectureWebSocket("wss://example.test/ws", () => socket)).toEqual({ ok: true, socket });
  });

  it("declares ready only after provider config and the first PCM are both ready", () => {
    let state: LiveClientHandshakeState = createLiveClientHandshakeState();
    const advance = (event: LiveClientHandshakeEvent): void => {
      const result = transitionLiveClientHandshake(state, event);
      expect(result.ok).toBe(true);
      if (result.ok) state = result.state;
    };

    expect(resolveLiveHandshakeView(state)).toEqual({
      ready: false,
      message: "음성 스트림을 준비하고 있습니다."
    });
    advance({ type: "server-capture-requested" });
    expect(resolveLiveHandshakeView(state)).toEqual({
      ready: false,
      message: "마이크 권한과 입력을 확인하고 있습니다."
    });
    advance({ type: "local-first-pcm" });
    advance({ type: "local-capture-ready-sent" });
    expect(resolveLiveHandshakeView(state)).toEqual({
      ready: false,
      message: "마이크가 준비되어 음성인식을 연결하고 있습니다."
    });
    advance({ type: "server-ready-for-audio" });
    expect(resolveLiveHandshakeView(state)).toEqual({
      ready: false,
      message: "AWS 음성인식 연결을 확인하고 있습니다."
    });
    advance({ type: "server-provider-accepted" });
    expect(resolveLiveHandshakeView(state)).toEqual({
      ready: true,
      message: "마이크와 음성인식이 준비되었습니다."
    });
  });

  it("rejects undocumented and out-of-order live handshake events", () => {
    const initial = createLiveClientHandshakeState();
    const earlyAudio = transitionLiveClientHandshake(initial, { type: "server-ready-for-audio" });
    expect(earlyAudio).toMatchObject({ ok: false, state: initial });

    const requested = transitionLiveClientHandshake(initial, { type: "server-capture-requested" });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    expect(
      transitionLiveClientHandshake(requested.state, { type: "server-provider-accepted" })
    ).toMatchObject({ ok: false, state: requested.state });
  });

  it("derives a 0.5 second browser high-water mark from the PCM byte rate", () => {
    expect(LIVE_AUDIO_MAX_BUFFERED_LAG_MS).toBe(500);
    expect(LIVE_AUDIO_MAX_BUFFERED_BYTES).toBe(16_000);
    expect(LIVE_CAPTURE_PERMISSION_TIMEOUT_MS).toBe(30_000);
    expect(LIVE_FIRST_PCM_TIMEOUT_MS).toBe(3_000);
  });

  it("preserves pre-ready PCM in FIFO order and closes the bounded queue after one flush", () => {
    const queue = createPreReadyPcmQueue(4);
    const sent: number[] = [];

    expect(queue.enqueue(Uint8Array.from([1, 1]).buffer)).toBe("queued");
    expect(queue.enqueue(Uint8Array.from([2, 2]).buffer)).toBe("queued");
    expect(queue.queuedBytes()).toBe(4);
    expect(queue.flush((audio) => {
      sent.push(new Uint8Array(audio)[0] ?? -1);
      return "sent";
    })).toBe("flushed");

    expect(sent).toEqual([1, 2]);
    expect(queue.queuedBytes()).toBe(0);
    expect(queue.enqueue(Uint8Array.from([3]).buffer)).toBe("closed");
  });

  it("rejects pre-ready audio beyond the 0.5-second memory bound without evicting older PCM", () => {
    const queue = createPreReadyPcmQueue(3);
    const first = Uint8Array.from([1, 2]).buffer;
    const sent: number[] = [];

    expect(queue.enqueue(first)).toBe("queued");
    expect(queue.enqueue(Uint8Array.from([3, 4]).buffer)).toBe("overflow");
    expect(queue.queuedBytes()).toBe(2);
    expect(queue.flush((audio) => {
      sent.push(...new Uint8Array(audio));
      return "sent";
    })).toBe("flushed");
    expect(sent).toEqual([1, 2]);
  });

  it("clears unsent pre-ready PCM after the first transport failure", () => {
    const queue = createPreReadyPcmQueue(8);
    queue.enqueue(Uint8Array.from([1, 1]).buffer);
    queue.enqueue(Uint8Array.from([2, 2]).buffer);

    expect(queue.flush(() => "backpressure")).toBe("backpressure");
    expect(queue.queuedBytes()).toBe(0);
    expect(queue.flush(() => "sent")).toBe("unavailable");
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
        segmentId: "segment-rag",
        revision: 2,
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
      segmentId: "segment-corrected",
      revision: 2,
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

import { describe, expect, it, vi } from "vitest";
import {
  beginLiveStopRequest,
  createCaptionReceiveToAfterPaintEstimator,
  createDevelopmentCaptionReceiveToAfterPaintEstimator,
  createFinalTranscriptLine,
  handleSocketTransportFailure,
  resolveMissingLiveStopRequestDisposition,
  resolveSocketTransportFailureDisposition
} from "./useLectureStream";

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

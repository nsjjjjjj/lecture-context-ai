import { describe, expect, it, vi } from "vitest";
import type { TranscriptEvent } from "../types.js";
import { createOutboundWebSocketFlowController } from "./outbound-websocket-flow.js";

function partial(segmentId: string, revision: number, text: string): TranscriptEvent {
  return { type: "partial", segmentId, revision, text };
}

function final(segmentId: string, revision: number, text: string): TranscriptEvent {
  return { type: "final", segmentId, revision, text };
}

function harness(overrides: { bufferedAmount?: number; maxQueuedBytes?: number; maxBufferedBytes?: number } = {}) {
  let bufferedAmount = overrides.bufferedAmount ?? 0;
  const sent: TranscriptEvent[] = [];
  const callbacks: Array<(error?: Error) => void> = [];
  const close = vi.fn();
  const terminate = vi.fn();
  const onOverflow = vi.fn();
  const controller = createOutboundWebSocketFlowController({
    transport: {
      isOpen: () => true,
      bufferedAmount: () => bufferedAmount,
      send: (payload, callback) => {
        sent.push(JSON.parse(payload) as TranscriptEvent);
        callbacks.push(callback);
      },
      close,
      terminate
    },
    highWaterMarkBytes: 10,
    maxBufferedBytes: overrides.maxBufferedBytes ?? 1_000,
    maxQueuedBytes: overrides.maxQueuedBytes ?? 1_000,
    drainIntervalMs: 60_000,
    drainTimeoutMs: 60_000,
    overflowEvent: { type: "error", message: "자막 전송 적체로 연결을 종료했습니다." },
    onOverflow
  });
  return {
    controller,
    sent,
    callbacks,
    close,
    terminate,
    onOverflow,
    setBufferedAmount: (value: number) => { bufferedAmount = value; }
  };
}

describe("outbound WebSocket flow", () => {
  it("느린 소켓에서는 같은 segment의 tail partial만 최신 revision으로 교체한다", () => {
    const test = harness({ bufferedAmount: 100 });

    expect(test.controller.send(partial("segment-a", 1, "초안"))).toBe("queued");
    expect(test.controller.send(partial("segment-a", 2, "최신 초안"))).toBe("coalesced");
    expect(test.controller.send(partial("segment-a", 1, "늦게 온 과거 초안"))).toBe("coalesced");
    test.setBufferedAmount(0);
    test.controller.flushNow();

    expect(test.sent).toEqual([partial("segment-a", 2, "최신 초안")]);
    test.controller.dispose();
  });

  it("final은 같은 segment의 바로 앞 partial만 대체하고 final·terminal 순서는 보존한다", () => {
    const test = harness({ bufferedAmount: 100 });

    test.controller.send(final("segment-a", 1, "첫 확정"));
    test.controller.send(partial("segment-b", 1, "둘째 초안"));
    test.controller.send(final("segment-b", 2, "둘째 확정"));
    test.controller.finish({ type: "ended", outcome: "completed", message: "끝" }, 1000, "completed");
    test.setBufferedAmount(0);
    test.controller.flushNow();

    expect(test.sent.map((event) => event.type)).toEqual(["final", "final", "ended"]);
    expect(test.sent.slice(0, 2).map((event) => "text" in event ? event.text : "")).toEqual([
      "첫 확정",
      "둘째 확정"
    ]);
    test.callbacks.at(-1)?.();
    expect(test.close).toHaveBeenCalledWith(1000, "completed");
    test.controller.dispose();
  });

  it("transport bufferedAmount가 hard limit를 넘으면 error를 한 번 보내고 1013으로 닫는다", () => {
    const test = harness({ bufferedAmount: 1_001, maxBufferedBytes: 1_000 });

    expect(test.controller.send(final("segment-a", 1, "확정"))).toBe("overflow");
    expect(test.onOverflow).toHaveBeenCalledOnce();
    expect(test.sent).toEqual([{ type: "error", message: "자막 전송 적체로 연결을 종료했습니다." }]);
    test.callbacks[0]?.();
    expect(test.close).toHaveBeenCalledWith(1013, "outbound flow overflow");
    expect(test.controller.send(partial("segment-a", 2, "더 늦은 초안"))).toBe("closed");
    test.controller.dispose();
  });

  it("bounded queue에 final을 더 담을 수 없으면 조용히 버리지 않고 overflow로 실패한다", () => {
    const test = harness({ bufferedAmount: 100, maxQueuedBytes: 80 });

    const result = test.controller.send(final("segment-a", 1, "가".repeat(100)));

    expect(result).toBe("overflow");
    expect(test.onOverflow).toHaveBeenCalledOnce();
    expect(test.sent.at(-1)).toMatchObject({ type: "error" });
    test.controller.dispose();
  });
});

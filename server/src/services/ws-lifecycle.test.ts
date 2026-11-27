import { describe, expect, it, vi } from "vitest";
import type { SttSession } from "./stt-session.js";
import {
  closeSpeechSessionForSocket,
  consumeSpeechEndMessage,
  requestLectureStop,
  USER_STOPPED_MESSAGE,
  type SttSessionSlot
} from "./ws-lifecycle.js";

function session(options: { finishInput?: () => void; abort?: () => void }): SttSession {
  return {
    enqueueAudio: vi.fn(() => "accepted"),
    finishInput: options.finishInput ?? vi.fn(),
    abort: options.abort ?? vi.fn()
  };
}

describe("WebSocket lecture stop lifecycle", () => {
  it("live stop은 상태를 draining으로 바꾼 뒤 세션을 half-close하고 즉시 ended를 보내지 않는다", async () => {
    const immediateEnd = vi.fn();
    const slot: SttSessionSlot = { active: null, pendingEndMessage: null };
    const close = vi.fn(() => {
      expect(slot.active).toBeNull();
      expect(slot.pendingEndMessage).toBe(USER_STOPPED_MESSAGE);
    });
    slot.active = session({ finishInput: close });

    await requestLectureStop(slot, immediateEnd);
    await requestLectureStop(slot, immediateEnd);

    expect(close).toHaveBeenCalledTimes(1);
    expect(immediateEnd).not.toHaveBeenCalled();
    expect(consumeSpeechEndMessage(slot, "Google STT 연결이 종료되었습니다.")).toBe(USER_STOPPED_MESSAGE);
  });

  it("provider 입력을 닫기 전에 마지막 서버 PCM flush가 끝날 때까지 기다린다", async () => {
    const events: string[] = [];
    let releaseFlush: (() => void) | undefined;
    const flush = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const slot: SttSessionSlot = {
      active: session({ finishInput: () => events.push("finishInput") }),
      pendingEndMessage: null
    };

    const stopping = requestLectureStop(slot, vi.fn(), async () => {
      events.push("flush:start");
      await flush;
      events.push("flush:end");
    });
    await Promise.resolve();
    expect(events).toEqual(["flush:start"]);
    expect(slot.active).not.toBeNull();

    releaseFlush?.();
    await stopping;

    expect(events).toEqual(["flush:start", "flush:end", "finishInput"]);
    expect(slot.active).toBeNull();
  });

  it("flush 대기 중 세션이 실패해 분리되면 finishInput을 다시 호출하지 않는다", async () => {
    let releaseFlush: (() => void) | undefined;
    const flush = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const finishInput = vi.fn();
    const slot: SttSessionSlot = {
      active: session({ finishInput }),
      pendingEndMessage: null
    };

    const stopping = requestLectureStop(slot, vi.fn(), () => flush);
    await Promise.resolve();
    closeSpeechSessionForSocket(slot);
    releaseFlush?.();
    await stopping;

    expect(finishInput).not.toHaveBeenCalled();
  });

  it("demo 또는 세션이 없는 stop은 즉시 ended를 보낸다", async () => {
    const immediateEnd = vi.fn();
    const slot: SttSessionSlot = { active: null, pendingEndMessage: null };

    await requestLectureStop(slot, immediateEnd);

    expect(immediateEnd).toHaveBeenCalledWith(USER_STOPPED_MESSAGE);
  });

  it("socket close는 활성 세션을 먼저 분리한 뒤 안전하게 닫는다", () => {
    const slot: SttSessionSlot = { active: null, pendingEndMessage: null };
    const close = vi.fn(() => expect(slot.active).toBeNull());
    slot.active = session({ abort: close });

    closeSpeechSessionForSocket(slot);
    closeSpeechSessionForSocket(slot);

    expect(close).toHaveBeenCalledTimes(1);
  });
});

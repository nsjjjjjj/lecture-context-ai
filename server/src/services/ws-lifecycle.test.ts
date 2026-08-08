import { describe, expect, it, vi } from "vitest";
import type { SpeechSession } from "./speech.js";
import {
  closeSpeechSessionForSocket,
  consumeSpeechEndMessage,
  requestLectureStop,
  USER_STOPPED_MESSAGE,
  type SpeechSessionSlot
} from "./ws-lifecycle.js";

function session(close: () => void): SpeechSession {
  return { close, writeAudio: vi.fn() };
}

describe("WebSocket lecture stop lifecycle", () => {
  it("live stop은 상태를 draining으로 바꾼 뒤 세션을 half-close하고 즉시 ended를 보내지 않는다", () => {
    const immediateEnd = vi.fn();
    const slot: SpeechSessionSlot = { active: null, pendingEndMessage: null };
    const close = vi.fn(() => {
      expect(slot.active).toBeNull();
      expect(slot.pendingEndMessage).toBe(USER_STOPPED_MESSAGE);
    });
    slot.active = session(close);

    requestLectureStop(slot, immediateEnd);
    requestLectureStop(slot, immediateEnd);

    expect(close).toHaveBeenCalledTimes(1);
    expect(immediateEnd).not.toHaveBeenCalled();
    expect(consumeSpeechEndMessage(slot, "Google STT 연결이 종료되었습니다.")).toBe(USER_STOPPED_MESSAGE);
  });

  it("demo 또는 세션이 없는 stop은 즉시 ended를 보낸다", () => {
    const immediateEnd = vi.fn();
    const slot: SpeechSessionSlot = { active: null, pendingEndMessage: null };

    requestLectureStop(slot, immediateEnd);

    expect(immediateEnd).toHaveBeenCalledWith(USER_STOPPED_MESSAGE);
  });

  it("socket close는 활성 세션을 먼저 분리한 뒤 안전하게 닫는다", () => {
    const slot: SpeechSessionSlot = { active: null, pendingEndMessage: null };
    const close = vi.fn(() => expect(slot.active).toBeNull());
    slot.active = session(close);

    closeSpeechSessionForSocket(slot);
    closeSpeechSessionForSocket(slot);

    expect(close).toHaveBeenCalledTimes(1);
  });
});

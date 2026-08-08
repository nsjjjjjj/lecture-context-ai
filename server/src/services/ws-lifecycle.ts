import type { SpeechSession } from "./speech.js";

export const USER_STOPPED_MESSAGE = "강연을 종료했습니다.";

export type SpeechSessionSlot = {
  active: SpeechSession | null;
  pendingEndMessage: string | null;
};

export function requestLectureStop(slot: SpeechSessionSlot, onImmediateEnd: (message: string) => void): void {
  if (slot.pendingEndMessage) return;

  const session = slot.active;
  if (!session) {
    onImmediateEnd(USER_STOPPED_MESSAGE);
    return;
  }

  slot.pendingEndMessage = USER_STOPPED_MESSAGE;
  slot.active = null;
  session.close();
}

export function consumeSpeechEndMessage(slot: SpeechSessionSlot, fallback: string): string {
  const message = slot.pendingEndMessage || fallback;
  slot.pendingEndMessage = null;
  return message;
}

export function clearPendingSpeechEnd(slot: SpeechSessionSlot): void {
  slot.pendingEndMessage = null;
}

export function closeSpeechSessionForSocket(slot: SpeechSessionSlot): void {
  const session = slot.active;
  slot.active = null;
  slot.pendingEndMessage = null;
  session?.close();
}

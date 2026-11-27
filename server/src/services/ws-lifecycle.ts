import type { SttSession } from "./stt-session.js";

export const USER_STOPPED_MESSAGE = "강연을 종료했습니다.";

export type SttSessionSlot = {
  active: SttSession | null;
  pendingEndMessage: string | null;
};

export async function requestLectureStop(
  slot: SttSessionSlot,
  onImmediateEnd: (message: string) => void,
  beforeFinishInput?: () => Promise<void>
): Promise<void> {
  if (slot.pendingEndMessage) return;

  const session = slot.active;
  if (!session) {
    onImmediateEnd(USER_STOPPED_MESSAGE);
    return;
  }

  slot.pendingEndMessage = USER_STOPPED_MESSAGE;
  await beforeFinishInput?.();
  if (slot.active !== session || slot.pendingEndMessage !== USER_STOPPED_MESSAGE) return;
  slot.active = null;
  session.finishInput();
}

export function consumeSpeechEndMessage(slot: SttSessionSlot, fallback: string): string {
  const message = slot.pendingEndMessage || fallback;
  slot.pendingEndMessage = null;
  return message;
}

export function clearPendingSpeechEnd(slot: SttSessionSlot): void {
  slot.pendingEndMessage = null;
}

export function closeSpeechSessionForSocket(slot: SttSessionSlot): void {
  const session = slot.active;
  slot.active = null;
  slot.pendingEndMessage = null;
  session?.abort();
}

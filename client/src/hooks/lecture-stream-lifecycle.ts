import type { LectureMode, LectureSessionOutcome } from "./lecture-stream-state";
import { hasLiveStreamingStarted, type LiveClientHandshakeState } from "./live-client-handshake";

export type LectureStopDisposition =
  | { kind: "return-terminal"; outcome: LectureSessionOutcome }
  | { kind: "no-active-session" }
  | { kind: "cancel-before-streaming"; mode: LectureMode }
  | { kind: "request-server-end"; mode: LectureMode }
  | { kind: "transport-failed" };

export function resolveLectureStopDisposition(input: {
  mode: LectureMode | null;
  socket: Pick<WebSocket, "readyState"> | null;
  liveHandshake: LiveClientHandshakeState | null;
  demoReady: boolean;
  terminalOutcome: LectureSessionOutcome | null;
}): LectureStopDisposition {
  if (!input.mode || !input.socket) {
    return input.terminalOutcome
      ? { kind: "return-terminal", outcome: input.terminalOutcome }
      : { kind: "no-active-session" };
  }

  if (input.socket.readyState === WebSocket.CONNECTING) {
    return { kind: "cancel-before-streaming", mode: input.mode };
  }

  if (input.socket.readyState === WebSocket.OPEN) {
    const started = input.mode === "live"
      ? input.liveHandshake !== null && hasLiveStreamingStarted(input.liveHandshake)
      : input.demoReady;
    return started
      ? { kind: "request-server-end", mode: input.mode }
      : { kind: "cancel-before-streaming", mode: input.mode };
  }

  return input.terminalOutcome
    ? { kind: "return-terminal", outcome: input.terminalOutcome }
    : { kind: "transport-failed" };
}

import { describe, expect, it } from "vitest";
import { resolveLectureStopDisposition } from "./lecture-stream-lifecycle";
import {
  createLiveClientHandshakeState,
  transitionLiveClientHandshake,
  type LiveClientHandshakeEvent,
  type LiveClientHandshakeState
} from "./live-client-handshake";

function advance(
  state: LiveClientHandshakeState,
  events: LiveClientHandshakeEvent[]
): LiveClientHandshakeState {
  return events.reduce((current, event) => {
    const result = transitionLiveClientHandshake(current, event);
    if (!result.ok) throw new Error(result.message);
    return result.state;
  }, state);
}

describe("lecture stream stop disposition", () => {
  it("distinguishes idle, connecting, streaming, and closing live sessions", () => {
    expect(resolveLectureStopDisposition({
      mode: null,
      socket: null,
      liveHandshake: null,
      demoReady: false,
      terminalOutcome: null
    })).toEqual({ kind: "no-active-session" });

    const handshake = createLiveClientHandshakeState();
    expect(resolveLectureStopDisposition({
      mode: "live",
      socket: { readyState: WebSocket.CONNECTING },
      liveHandshake: handshake,
      demoReady: false,
      terminalOutcome: null
    })).toEqual({ kind: "cancel-before-streaming", mode: "live" });

    const streaming = advance(handshake, [
      { type: "server-capture-requested" },
      { type: "local-capture-ready-sent" },
      { type: "server-ready-for-audio" }
    ]);
    expect(resolveLectureStopDisposition({
      mode: "live",
      socket: { readyState: WebSocket.OPEN },
      liveHandshake: streaming,
      demoReady: false,
      terminalOutcome: null
    })).toEqual({ kind: "request-server-end", mode: "live" });

    expect(resolveLectureStopDisposition({
      mode: "live",
      socket: { readyState: WebSocket.CLOSING },
      liveHandshake: streaming,
      demoReady: false,
      terminalOutcome: null
    })).toEqual({ kind: "transport-failed" });
  });

  it("distinguishes demo preparation from an active demo and preserves a known terminal result", () => {
    const openSocket = { readyState: WebSocket.OPEN };
    expect(resolveLectureStopDisposition({
      mode: "demo",
      socket: openSocket,
      liveHandshake: null,
      demoReady: false,
      terminalOutcome: null
    })).toEqual({ kind: "cancel-before-streaming", mode: "demo" });
    expect(resolveLectureStopDisposition({
      mode: "demo",
      socket: openSocket,
      liveHandshake: null,
      demoReady: true,
      terminalOutcome: null
    })).toEqual({ kind: "request-server-end", mode: "demo" });

    const terminalOutcome = {
      status: "completed" as const,
      reason: "server-ended" as const,
      message: "완료"
    };
    expect(resolveLectureStopDisposition({
      mode: null,
      socket: null,
      liveHandshake: null,
      demoReady: false,
      terminalOutcome
    })).toEqual({ kind: "return-terminal", outcome: terminalOutcome });
  });
});

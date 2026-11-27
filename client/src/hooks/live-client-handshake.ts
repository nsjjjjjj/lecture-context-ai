export type LiveClientHandshakeState =
  | { phase: "awaiting-capture-request" }
  | { phase: "capture-requested"; firstPcmReceived: boolean }
  | { phase: "capture-ready-sent"; firstPcmReceived: boolean }
  | { phase: "audio-ready"; firstPcmReceived: boolean }
  | { phase: "provider-accepted"; firstPcmReceived: false }
  | { phase: "ready"; firstPcmReceived: true }
  | { phase: "terminal" };

export type LiveClientHandshakeEvent =
  | { type: "server-capture-requested" }
  | { type: "local-first-pcm" }
  | { type: "local-capture-ready-sent" }
  | { type: "server-ready-for-audio" }
  | { type: "server-provider-accepted" }
  | { type: "terminal" };

export type LiveClientHandshakeTransition =
  | { ok: true; state: LiveClientHandshakeState }
  | { ok: false; state: LiveClientHandshakeState; message: string };

export function createLiveClientHandshakeState(): LiveClientHandshakeState {
  return { phase: "awaiting-capture-request" };
}

function invalidTransition(
  state: LiveClientHandshakeState,
  event: LiveClientHandshakeEvent
): LiveClientHandshakeTransition {
  return {
    ok: false,
    state,
    message: `실시간 자막 준비 순서가 올바르지 않습니다. (${state.phase} 단계에서 ${event.type} 수신)`
  };
}

export function transitionLiveClientHandshake(
  state: LiveClientHandshakeState,
  event: LiveClientHandshakeEvent
): LiveClientHandshakeTransition {
  if (event.type === "terminal") return { ok: true, state: { phase: "terminal" } };
  if (state.phase === "terminal") return invalidTransition(state, event);

  if (event.type === "server-capture-requested") {
    return state.phase === "awaiting-capture-request"
      ? { ok: true, state: { phase: "capture-requested", firstPcmReceived: false } }
      : invalidTransition(state, event);
  }

  if (event.type === "local-first-pcm") {
    if (state.phase === "capture-requested" || state.phase === "capture-ready-sent" || state.phase === "audio-ready") {
      return { ok: true, state: { ...state, firstPcmReceived: true } };
    }
    if (state.phase === "provider-accepted") {
      return { ok: true, state: { phase: "ready", firstPcmReceived: true } };
    }
    if (state.phase === "ready") return { ok: true, state };
    return invalidTransition(state, event);
  }

  if (event.type === "local-capture-ready-sent") {
    return state.phase === "capture-requested"
      ? {
          ok: true,
          state: { phase: "capture-ready-sent", firstPcmReceived: state.firstPcmReceived }
        }
      : invalidTransition(state, event);
  }

  if (event.type === "server-ready-for-audio") {
    return state.phase === "capture-ready-sent"
      ? { ok: true, state: { phase: "audio-ready", firstPcmReceived: state.firstPcmReceived } }
      : invalidTransition(state, event);
  }

  if (event.type === "server-provider-accepted") {
    if (state.phase !== "audio-ready") return invalidTransition(state, event);
    return state.firstPcmReceived
      ? { ok: true, state: { phase: "ready", firstPcmReceived: true } }
      : { ok: true, state: { phase: "provider-accepted", firstPcmReceived: false } };
  }

  return invalidTransition(state, event);
}

export function canForwardLiveAudio(state: LiveClientHandshakeState): boolean {
  return state.phase === "audio-ready" || state.phase === "provider-accepted" || state.phase === "ready";
}

export function hasLiveStreamingStarted(state: LiveClientHandshakeState): boolean {
  return canForwardLiveAudio(state);
}

export function hasReceivedFirstPcm(state: LiveClientHandshakeState): boolean {
  return "firstPcmReceived" in state && state.firstPcmReceived;
}

export function resolveLiveHandshakeView(state: LiveClientHandshakeState): {
  ready: boolean;
  message: string;
} {
  switch (state.phase) {
    case "awaiting-capture-request":
      return { ready: false, message: "음성 스트림을 준비하고 있습니다." };
    case "capture-requested":
      return { ready: false, message: "마이크 권한과 입력을 확인하고 있습니다." };
    case "capture-ready-sent":
      return { ready: false, message: "마이크가 준비되어 음성인식을 연결하고 있습니다." };
    case "audio-ready":
      return {
        ready: false,
        message: state.firstPcmReceived
          ? "AWS 음성인식 연결을 확인하고 있습니다."
          : "마이크 입력과 AWS 음성인식 연결을 확인하고 있습니다."
      };
    case "provider-accepted":
      return { ready: false, message: "AWS 연결이 승인되었습니다. 마이크 입력을 확인하고 있습니다." };
    case "ready":
      return { ready: true, message: "마이크와 음성인식이 준비되었습니다." };
    case "terminal":
      return { ready: false, message: "음성 스트림이 종료되었습니다." };
  }
}

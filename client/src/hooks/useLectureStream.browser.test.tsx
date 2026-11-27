// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlossaryTerm } from "../types";
import {
  useLectureStream,
  type LecturePcmRecorderPort,
  type LectureStreamDependencies
} from "./useLectureStream";
import {
  LIVE_CAPTURE_PERMISSION_TIMEOUT_MS,
  LIVE_FIRST_PCM_TIMEOUT_MS,
  LIVE_START_HANDSHAKE_TIMEOUT_MS
} from "./lecture-session-deadlines";

const NO_TERMS: GlossaryTerm[] = [];
const NO_PHRASES: string[] = [];

function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class ControlledRecorder implements LecturePcmRecorderPort {
  private readonly startDeferred = deferredVoid();
  private readonly stopDeferred: ReturnType<typeof deferredVoid> | null;
  private callbacks: Parameters<LecturePcmRecorderPort["start"]>[1];
  private onAudio: ((buffer: ArrayBuffer) => void) | null = null;
  private firstPcmEmitted = false;
  startCalls = 0;
  stopCalls = 0;

  constructor(stopPending = false) {
    this.stopDeferred = stopPending ? deferredVoid() : null;
  }

  async start(
    onAudio: (buffer: ArrayBuffer) => void,
    callbacks?: Parameters<LecturePcmRecorderPort["start"]>[1]
  ): Promise<void> {
    this.startCalls += 1;
    this.onAudio = onAudio;
    this.callbacks = callbacks;
    await this.startDeferred.promise;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    await this.stopDeferred?.promise;
  }

  finishStart(withFirstPcm = true): void {
    if (withFirstPcm && !this.firstPcmEmitted) {
      this.firstPcmEmitted = true;
      this.callbacks?.onFirstPcm?.();
    }
    this.startDeferred.resolve();
  }

  emitAudio(...bytes: number[]): void {
    this.emitBuffer(Uint8Array.from(bytes).buffer);
  }

  emitBuffer(buffer: ArrayBuffer): void {
    if (!this.firstPcmEmitted) {
      this.firstPcmEmitted = true;
      this.callbacks?.onFirstPcm?.();
    }
    this.onAudio?.(buffer);
  }

  finishStop(): void {
    this.stopDeferred?.resolve();
  }
}

class FakeLectureSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  readyState = FakeLectureSocket.CONNECTING;
  onopen: WebSocket["onopen"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onerror: WebSocket["onerror"] = null;
  onclose: WebSocket["onclose"] = null;
  readonly sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];

  constructor(readonly url: string) {}

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== FakeLectureSocket.OPEN) throw new Error("socket is not open");
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeLectureSocket.CLOSED;
  }

  beginClosing(): void {
    this.readyState = FakeLectureSocket.CLOSING;
  }

  open(): void {
    this.readyState = FakeLectureSocket.OPEN;
    this.onopen?.call(this as unknown as WebSocket, new Event("open"));
  }

  receive(event: unknown): void {
    this.onmessage?.call(
      this as unknown as WebSocket,
      new MessageEvent("message", { data: JSON.stringify(event) })
    );
  }

  sentJson(): unknown[] {
    return this.sent
      .filter((value): value is string => typeof value === "string")
      .map((value) => JSON.parse(value) as unknown);
  }

  sentBinary(): ArrayBuffer[] {
    return this.sent.filter((value): value is ArrayBuffer => value instanceof ArrayBuffer);
  }
}

function createHarness(recorders: ControlledRecorder[]) {
  const sockets: FakeLectureSocket[] = [];
  const recorderQueue = [...recorders];
  const dependencies: LectureStreamDependencies = {
    createWebSocket(address) {
      const socket = new FakeLectureSocket(address);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    createRecorder() {
      const recorder = recorderQueue.shift();
      if (!recorder) throw new Error("No controlled recorder was queued for this session.");
      return recorder;
    }
  };
  const hook = renderHook(() => useLectureStream(NO_TERMS, NO_PHRASES, dependencies));
  return { ...hook, sockets };
}

async function flushReactWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function beginLiveSession(
  result: ReturnType<typeof createHarness>["result"]
): Promise<void> {
  await act(async () => {
    await result.current.start("live");
  });
}

async function openAndAccept(socket: FakeLectureSocket, recorder: ControlledRecorder): Promise<void> {
  act(() => {
    socket.open();
    socket.receive({ type: "captureRequested", message: "마이크 권한 확인" });
    recorder.finishStart();
  });
  await flushReactWork();
  act(() => {
    socket.receive({ type: "readyForAudio", message: "오디오 전송 가능" });
    socket.receive({ type: "providerAccepted", message: "AWS 연결 승인" });
  });
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeLectureSocket);
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: vi.fn(() => 1)
  });
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useLectureStream browser lifecycle", () => {
  it("returns a no-active-session outcome for idle stop without fabricating completion", async () => {
    const { result } = createHarness([]);

    let outcome!: Awaited<ReturnType<typeof result.current.stop>>;
    await act(async () => {
      outcome = await result.current.stop();
    });

    expect(outcome).toEqual({
      status: "no-active-session",
      reason: "idle",
      message: "종료할 강연이 없습니다."
    });
    expect(result.current.status).toBe("idle");
    expect(result.current.sessionOutcome).toBeNull();
  });

  it("cancels an opening live socket before streaming without claiming an AWS flush", async () => {
    const recorder = new ControlledRecorder();
    const { result, sockets } = createHarness([recorder]);
    await beginLiveSession(result);

    let outcome!: Awaited<ReturnType<typeof result.current.stop>>;
    await act(async () => {
      outcome = await result.current.stop();
    });

    expect(outcome).toMatchObject({
      status: "cancelled-before-streaming",
      reason: "live-connecting"
    });
    expect(outcome.message).toContain("음성 전송이 시작되기 전에");
    expect(sockets[0].readyState).toBe(FakeLectureSocket.CLOSED);
    expect(recorder.startCalls).toBe(0);
    expect(result.current.status).toBe("idle");
    expect(result.current.sessionOutcome).toBeNull();
  });

  it("treats a closing socket race as a transport error, never a completed stop", async () => {
    const recorder = new ControlledRecorder();
    const { result, sockets } = createHarness([recorder]);
    await beginLiveSession(result);
    const socket = sockets[0];
    await openAndAccept(socket, recorder);
    act(() => socket.beginClosing());

    let outcome!: Awaited<ReturnType<typeof result.current.stop>>;
    await act(async () => {
      outcome = await result.current.stop();
    });

    expect(outcome).toMatchObject({ status: "transport-error", reason: "socket" });
    expect(outcome.message).toContain("닫히는 중");
    expect(result.current.status).toBe("error");
    expect(result.current.sessionOutcome).toEqual(outcome);
  });

  it("waits for the demo server ended event instead of locally fabricating completion", async () => {
    const { result, sockets } = createHarness([]);
    await act(async () => {
      await result.current.start("demo");
    });
    const socket = sockets[0];
    act(() => {
      socket.open();
      socket.receive({ type: "ready", message: "데모 준비 완료" });
    });
    expect(result.current.status).toBe("ready");

    let stopPromise!: ReturnType<typeof result.current.stop>;
    let settled = false;
    act(() => {
      stopPromise = result.current.stop();
      void stopPromise.then(() => {
        settled = true;
      });
    });
    await flushReactWork();
    expect(socket.sentJson()).toContainEqual({ type: "stop" });
    expect(settled).toBe(false);

    let outcome!: Awaited<typeof stopPromise>;
    await act(async () => {
      socket.receive({ type: "ended", outcome: "completed", message: "데모 강연을 종료했습니다." });
      outcome = await stopPromise;
    });
    expect(outcome).toEqual({
      status: "completed",
      reason: "server-ended",
      message: "데모 강연을 종료했습니다."
    });
    expect(result.current.sessionOutcome).toEqual(outcome);
  });

  it("rejects the undocumented generic ready shortcut in a live session", async () => {
    const recorder = new ControlledRecorder();
    const { result, sockets } = createHarness([recorder]);
    await beginLiveSession(result);
    const socket = sockets[0];

    act(() => {
      socket.open();
      socket.receive({ type: "ready", message: "legacy ready" });
    });
    await flushReactWork();

    expect(result.current.status).toBe("error");
    expect(result.current.sessionOutcome).toMatchObject({ status: "transport-error", reason: "protocol" });
    expect(result.current.statusMessage).toContain("이전 준비 신호");
    expect(recorder.startCalls).toBe(0);
  });

  it("keeps permission waiting separate from handshake timeout and still bounds it", async () => {
    vi.useFakeTimers();
    const recorder = new ControlledRecorder();
    const { result, sockets } = createHarness([recorder]);

    await beginLiveSession(result);
    const socket = sockets[0];
    act(() => {
      socket.open();
      socket.receive({ type: "captureRequested", message: "마이크 권한을 기다리고 있습니다." });
    });
    expect(recorder.startCalls).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_START_HANDSHAKE_TIMEOUT_MS + 1);
    });

    expect(socket.readyState).toBe(FakeLectureSocket.OPEN);
    expect(result.current.status).toBe("connecting");
    expect(result.current.sessionOutcome).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        LIVE_CAPTURE_PERMISSION_TIMEOUT_MS - LIVE_START_HANDSHAKE_TIMEOUT_MS - 1
      );
      await Promise.resolve();
    });
    expect(socket.readyState).toBe(FakeLectureSocket.CLOSED);
    expect(result.current.status).toBe("error");
    expect(result.current.sessionOutcome).toMatchObject({ status: "transport-error", reason: "capture" });
  });

  it("opens the provider phase only after recorder setup reports captureReady", async () => {
    const recorder = new ControlledRecorder();
    const { result, sockets } = createHarness([recorder]);

    await beginLiveSession(result);
    const socket = sockets[0];
    act(() => {
      socket.open();
      socket.receive({ type: "captureRequested", message: "마이크 권한 확인" });
    });
    expect(socket.sentJson()).not.toContainEqual({ type: "captureReady" });

    act(() => recorder.finishStart());
    await flushReactWork();
    expect(socket.sentJson()).toContainEqual({ type: "captureReady" });

    act(() => {
      socket.receive({ type: "readyForAudio", message: "오디오 전송 가능" });
      socket.receive({ type: "providerAccepted", message: "AWS 연결 승인" });
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.sessionOutcome).toBeNull();
  });

  it("bounds the provider phase after captureReady instead of waiting forever", async () => {
    vi.useFakeTimers();
    const recorder = new ControlledRecorder();
    const { result, sockets } = createHarness([recorder]);

    await beginLiveSession(result);
    const socket = sockets[0];
    act(() => {
      socket.open();
      socket.receive({ type: "captureRequested", message: "마이크 권한 확인" });
      recorder.finishStart();
    });
    await flushReactWork();
    expect(socket.sentJson()).toContainEqual({ type: "captureReady" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_START_HANDSHAKE_TIMEOUT_MS);
      await Promise.resolve();
    });

    expect(socket.readyState).toBe(FakeLectureSocket.CLOSED);
    expect(result.current.status).toBe("error");
    expect(result.current.sessionOutcome).toMatchObject({
      status: "transport-error",
      reason: "start-handshake-timeout"
    });
    expect(result.current.statusMessage).toContain("오디오 전송을 승인하지 않았습니다");
  });

  it("flushes bounded pre-ready PCM in capture order before forwarding new live audio", async () => {
    const recorder = new ControlledRecorder();
    const { result, sockets } = createHarness([recorder]);

    await beginLiveSession(result);
    const socket = sockets[0];
    act(() => {
      socket.open();
      socket.receive({ type: "captureRequested", message: "마이크 권한 확인" });
      recorder.emitAudio(1, 1);
      recorder.emitAudio(2, 2);
      recorder.finishStart(false);
    });
    await flushReactWork();
    expect(socket.sentBinary()).toEqual([]);
    expect(socket.sentJson()).toContainEqual({ type: "captureReady" });

    act(() => socket.receive({ type: "readyForAudio", message: "오디오 전송 가능" }));
    expect(socket.sentBinary().map((audio) => new Uint8Array(audio)[0])).toEqual([1, 2]);

    act(() => recorder.emitAudio(3, 3));
    expect(socket.sentBinary().map((audio) => new Uint8Array(audio)[0])).toEqual([1, 2, 3]);
  });

  it("fails explicitly instead of evicting speech when the pre-ready PCM bound is exceeded", async () => {
    const recorder = new ControlledRecorder();
    const { result, sockets } = createHarness([recorder]);

    await beginLiveSession(result);
    const socket = sockets[0];
    act(() => {
      socket.open();
      socket.receive({ type: "captureRequested", message: "마이크 권한 확인" });
      for (let index = 0; index < 6; index += 1) recorder.emitBuffer(new ArrayBuffer(3_200));
    });
    await flushReactWork();

    expect(socket.sentBinary()).toEqual([]);
    expect(socket.readyState).toBe(FakeLectureSocket.CLOSED);
    expect(result.current.status).toBe("error");
    expect(result.current.statusMessage).toContain("0.5초 이상 지연");
  });

  it("clears unconfirmed partial text when a fatal server error ends the session", async () => {
    const recorder = new ControlledRecorder();
    const { result, sockets } = createHarness([recorder]);
    await beginLiveSession(result);
    const socket = sockets[0];
    await openAndAccept(socket, recorder);

    act(() => {
      socket.receive({
        type: "partial",
        segmentId: "unconfirmed",
        revision: 1,
        text: "아직 확정되지 않은 문장"
      });
    });
    expect(result.current.interim).toBe("아직 확정되지 않은 문장");

    act(() => socket.receive({ type: "error", message: "AWS 연결 오류" }));
    await flushReactWork();

    expect(result.current.status).toBe("error");
    expect(result.current.interim).toBe("");
    expect(result.current.partialSegments).toEqual([]);
    expect(result.current.transcript.lineCount).toBe(0);
  });

  it("starts the short first-PCM timer only after recorder setup, not during permission", async () => {
    vi.useFakeTimers();
    const recorder = new ControlledRecorder();
    const { result, sockets } = createHarness([recorder]);

    await beginLiveSession(result);
    const socket = sockets[0];
    act(() => {
      socket.open();
      socket.receive({ type: "captureRequested", message: "마이크 권한 확인" });
      recorder.finishStart(false);
    });
    await flushReactWork();
    expect(socket.sentJson()).toContainEqual({ type: "captureReady" });

    act(() => socket.receive({ type: "readyForAudio", message: "오디오 전송 가능" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_FIRST_PCM_TIMEOUT_MS - 1);
    });
    expect(socket.readyState).toBe(FakeLectureSocket.OPEN);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
    });
    expect(socket.readyState).toBe(FakeLectureSocket.CLOSED);
    expect(result.current.sessionOutcome).toMatchObject({ status: "transport-error", reason: "capture" });
    expect(result.current.statusMessage).toContain("PCM 오디오");
  });

  it("discards a session while its WebSocket is still opening and ignores late socket events", async () => {
    const recorder = new ControlledRecorder();
    const { result, sockets } = createHarness([recorder]);

    await beginLiveSession(result);
    const socket = sockets[0];
    expect(result.current.status).toBe("connecting");

    act(() => result.current.discardSession());
    await flushReactWork();

    expect(result.current.status).toBe("idle");
    expect(socket.readyState).toBe(FakeLectureSocket.CLOSED);
    expect(socket.onopen).toBeNull();
    expect(recorder.startCalls).toBe(0);

    act(() => {
      socket.open();
      socket.receive({ type: "ready" });
    });
    expect(result.current.status).toBe("idle");
    expect(socket.sentJson()).toEqual([]);
  });

  it("discards during recorder startup and cannot be revived by its late completion", async () => {
    const recorder = new ControlledRecorder();
    const { result, sockets } = createHarness([recorder]);

    await beginLiveSession(result);
    const socket = sockets[0];
    act(() => {
      socket.open();
      socket.receive({ type: "captureRequested", message: "마이크 권한 확인" });
      recorder.emitAudio(9, 9);
    });
    expect(recorder.startCalls).toBe(1);
    expect(socket.sentBinary()).toEqual([]);

    act(() => result.current.discardSession());
    await flushReactWork();
    expect(result.current.status).toBe("idle");
    expect(recorder.stopCalls).toBe(1);

    act(() => recorder.finishStart());
    await flushReactWork();
    act(() => {
      socket.receive({
        type: "final",
        segmentId: "discarded-final",
        revision: 1,
        text: "폐기된 세션 자막"
      });
    });

    expect(result.current.status).toBe("idle");
    expect(result.current.captionTail).toEqual([]);
    expect(socket.sentBinary()).toEqual([]);
    expect(result.current.sessionOutcome).toBeNull();
    expect(recorder.stopCalls).toBeGreaterThanOrEqual(1);
  });

  it("keeps a late final and server-ended outcome before resolving live stop", async () => {
    const recorder = new ControlledRecorder();
    recorder.finishStart(false);
    const { result, sockets } = createHarness([recorder]);

    await beginLiveSession(result);
    const socket = sockets[0];
    await openAndAccept(socket, recorder);
    expect(result.current.status).toBe("ready");

    let stopPromise!: ReturnType<typeof result.current.stop>;
    let stopSettled = false;
    act(() => {
      stopPromise = result.current.stop();
      void stopPromise.then(() => {
        stopSettled = true;
      });
    });
    await flushReactWork();
    expect(result.current.status).toBe("stopping");
    expect(socket.sentJson()).toContainEqual({ type: "stop" });

    act(() => {
      socket.receive({
        type: "final",
        segmentId: "late-final",
        revision: 2,
        text: "종료 직전 확정 자막",
        rawText: "종료 직전 확정 자막",
        detectedTerms: []
      });
    });
    expect(result.current.captionTail.map((line) => line.text)).toEqual(["종료 직전 확정 자막"]);
    expect(stopSettled).toBe(false);

    let outcome!: Awaited<typeof stopPromise>;
    await act(async () => {
      socket.receive({ type: "ended", outcome: "completed", message: "마지막 자막까지 확정했습니다." });
      outcome = await stopPromise;
    });

    expect(outcome).toEqual({
      status: "completed",
      reason: "server-ended",
      message: "마지막 자막까지 확정했습니다."
    });
    expect(result.current.status).toBe("ended");
    expect(result.current.sessionOutcome).toEqual(outcome);
    expect(result.current.captionTail.map((line) => line.text)).toEqual(["종료 직전 확정 자막"]);
  });

  it("does not let a superseded pending stop shut down the restarted session recorder", async () => {
    const firstRecorder = new ControlledRecorder(true);
    firstRecorder.finishStart(false);
    const secondRecorder = new ControlledRecorder();
    secondRecorder.finishStart(false);
    const { result, sockets } = createHarness([firstRecorder, secondRecorder]);

    await beginLiveSession(result);
    const firstSocket = sockets[0];
    await openAndAccept(firstSocket, firstRecorder);

    let oldStop!: ReturnType<typeof result.current.stop>;
    act(() => {
      oldStop = result.current.stop();
    });
    await flushReactWork();
    expect(firstRecorder.stopCalls).toBe(1);
    expect(result.current.status).toBe("stopping");

    await beginLiveSession(result);
    const secondSocket = sockets[1];
    await openAndAccept(secondSocket, secondRecorder);
    expect(result.current.status).toBe("ready");

    act(() => {
      secondSocket.receive({
        type: "final",
        segmentId: "new-session-final",
        revision: 1,
        text: "새 세션 자막"
      });
      firstRecorder.finishStop();
    });
    let oldOutcome!: Awaited<typeof oldStop>;
    await act(async () => {
      oldOutcome = await oldStop;
    });

    expect(oldOutcome).toMatchObject({ status: "cancelled", reason: "superseded" });
    expect(secondRecorder.stopCalls).toBe(0);
    expect(secondSocket.readyState).toBe(FakeLectureSocket.OPEN);
    expect(result.current.status).toBe("ready");
    expect(result.current.captionTail.map((line) => line.text)).toEqual(["새 세션 자막"]);
  });
});

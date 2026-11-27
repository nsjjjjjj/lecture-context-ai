import { useCallback, useEffect, useReducer, useRef } from "react";
import { PcmRecorder, PcmRecorderStartCancelledError } from "../lib/pcm-recorder";
import type { GlossaryTerm, TranscriptLine, TranscriptSegmentEvent } from "../types";
import {
  handleLectureStreamSocketData,
  resolveEndedEventOutcome,
  shouldIgnoreLectureStreamEventAfterStop,
  type LectureStreamServerEvent
} from "./lecture-stream-events";
import {
  createInitialLectureStreamState,
  createLectureStartMessage,
  isCurrentLectureSession,
  lectureStreamReducer,
  type LectureMode,
  type LectureSessionOutcome,
  type LectureStartOutcome,
  type LectureStopOutcome
} from "./lecture-stream-state";
import { createLiveStopGate, type LiveStopGate } from "./lecture-stop-gate";
import {
  createLectureSessionDeadlineController,
  LIVE_CAPTURE_PERMISSION_TIMEOUT_MS,
  LIVE_FIRST_PCM_TIMEOUT_MS,
  LIVE_SOCKET_OPEN_TIMEOUT_MS,
  LIVE_START_HANDSHAKE_TIMEOUT_MS,
  type LectureSessionDeadlineController
} from "./lecture-session-deadlines";
import {
  createDevelopmentCaptionReceiveToAfterPaintEstimator,
  createDevelopmentLiveClientDiagnostics,
  handleSocketTransportFailure,
  resolveMissingLiveStopRequestDisposition,
  type CaptionReceiveToAfterPaintEstimator,
  type LiveClientDiagnostics,
  type SocketTransportFailureSource
} from "./lecture-stream-diagnostics";
import { resolveLectureStopDisposition } from "./lecture-stream-lifecycle";
import {
  canForwardLiveAudio,
  createLiveClientHandshakeState,
  hasReceivedFirstPcm,
  hasLiveStreamingStarted,
  resolveLiveHandshakeView,
  transitionLiveClientHandshake,
  type LiveClientHandshakeEvent,
  type LiveClientHandshakeState
} from "./live-client-handshake";
import {
  createPreReadyPcmQueue,
  LIVE_AUDIO_MAX_BUFFERED_LAG_MS,
  sendLiveAudioChunk,
  type PreReadyPcmQueue
} from "./live-audio-transport";

function detachSocket(socket: WebSocket): void {
  socket.onopen = null;
  socket.onmessage = null;
  socket.onerror = null;
  socket.onclose = null;
}

export type LectureWebSocketCreationResult =
  | { ok: true; socket: WebSocket }
  | { ok: false };

export function createLectureWebSocket(
  url: string,
  create: (address: string) => WebSocket = (address) => new WebSocket(address)
): LectureWebSocketCreationResult {
  try {
    return { ok: true, socket: create(url) };
  } catch {
    return { ok: false };
  }
}

export type LecturePcmRecorderPort = {
  start: (
    onAudio: (buffer: ArrayBuffer) => void,
    callbacks?: {
      onFirstPcm?: () => void;
      onError?: (error: Error) => void;
    }
  ) => Promise<void>;
  stop: () => Promise<void>;
};

export type LectureStreamDependencies = {
  createWebSocket?: (address: string) => WebSocket;
  createRecorder?: () => LecturePcmRecorderPort;
};

const DEFAULT_LECTURE_STREAM_DEPENDENCIES: LectureStreamDependencies = {};
const createBrowserWebSocket = (address: string): WebSocket => new WebSocket(address);
const createBrowserRecorder = (): LecturePcmRecorderPort => new PcmRecorder();

type LiveStopRequest = {
  waitForServer: Promise<void>;
};

export async function beginLiveStopRequest(
  stopRecorder: () => Promise<void>,
  canSend: () => boolean,
  prepareWait: () => Promise<void>,
  sendStop: () => void
): Promise<LiveStopRequest | null> {
  await stopRecorder();
  if (!canSend()) return null;

  const waitForServer = prepareWait();
  sendStop();
  return { waitForServer };
}

export function createFinalTranscriptLine(event: TranscriptSegmentEvent, id = event.segmentId): {
  line: TranscriptLine;
  occurrenceTermIds: string[];
} {
  const occurrenceTermIds = event.detectedTerms || [];
  return {
    line: {
      id,
      text: event.text || "",
      rawText: event.rawText || event.text || "",
      termIds: [...new Set(occurrenceTermIds)],
      relatedPage: event.relatedPage,
      corrections: event.corrections || []
    },
    occurrenceTermIds
  };
}

export function useLectureStream(
  terms: GlossaryTerm[],
  phraseSet: string[],
  dependencies: LectureStreamDependencies = DEFAULT_LECTURE_STREAM_DEPENDENCIES
) {
  const createWebSocket = dependencies.createWebSocket ?? createBrowserWebSocket;
  const createRecorder = dependencies.createRecorder ?? createBrowserRecorder;
  const [state, dispatch] = useReducer(lectureStreamReducer, undefined, createInitialLectureStreamState);
  const socketRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<LecturePcmRecorderPort | null>(null);
  const recorderOwnerRef = useRef<WebSocket | null>(null);
  const sessionGenerationRef = useRef(0);
  const modeRef = useRef<LectureMode | null>(null);
  const stopRequestedSocketRef = useRef<WebSocket | null>(null);
  const stopPromiseRef = useRef<Promise<LectureStopOutcome> | null>(null);
  const sessionOutcomeRef = useRef<LectureSessionOutcome | null>(null);
  const liveStopGateRef = useRef<LiveStopGate | null>(null);
  const captionTimingEstimatorRef = useRef<CaptionReceiveToAfterPaintEstimator | null>(null);
  const liveDiagnosticsRef = useRef<LiveClientDiagnostics | null>(null);
  const sessionDeadlinesRef = useRef<LectureSessionDeadlineController | null>(null);
  const preReadyPcmRef = useRef<{ owner: WebSocket; queue: PreReadyPcmQueue } | null>(null);
  const liveHandshakeRef = useRef<{ owner: WebSocket; state: LiveClientHandshakeState } | null>(null);
  const demoReadySocketRef = useRef<WebSocket | null>(null);
  if (!liveStopGateRef.current) liveStopGateRef.current = createLiveStopGate();
  if (!sessionDeadlinesRef.current) sessionDeadlinesRef.current = createLectureSessionDeadlineController();

  useEffect(() => {
    const estimator = createDevelopmentCaptionReceiveToAfterPaintEstimator(import.meta.env.DEV, {
      requestAnimationFrame: (callback) => window.requestAnimationFrame(() => callback()),
      scheduleAfterFrameTask: (callback) => window.setTimeout(callback, 0),
      now: () => window.performance.now(),
      reporter: (estimate) => console.debug("[caption-receive-to-after-paint-estimate]", estimate)
    });
    captionTimingEstimatorRef.current = estimator;
    return () => {
      if (captionTimingEstimatorRef.current === estimator) captionTimingEstimatorRef.current = null;
    };
  }, []);

  const stopRecorder = useCallback(async (expectedOwner?: WebSocket) => {
    const recorder = recorderRef.current;
    if (!recorder || (expectedOwner && recorderOwnerRef.current !== expectedOwner)) return;
    recorderRef.current = null;
    recorderOwnerRef.current = null;
    await recorder.stop();
  }, []);

  const shutDownConnection = useCallback(
    async (notifyServer: boolean, expectedSocket?: WebSocket, settlePendingStop = true) => {
      const socket = expectedSocket || socketRef.current;
      const ownsActiveConnection = !socket || socketRef.current === socket;
      if (socket) sessionDeadlinesRef.current?.clearSession(socket);
      if (!socket || preReadyPcmRef.current?.owner === socket) {
        preReadyPcmRef.current?.queue.clear();
        preReadyPcmRef.current = null;
      }
      if (!socket || liveHandshakeRef.current?.owner === socket) liveHandshakeRef.current = null;
      if (!socket || demoReadySocketRef.current === socket) demoReadySocketRef.current = null;
      if (socket && socketRef.current === socket) {
        if (notifyServer && socket.readyState === WebSocket.OPEN) {
          try {
            socket.send(JSON.stringify({ type: "stop" }));
          } catch {
            // Forceful restart/unmount cleanup must continue if send races with socket closure.
          }
        }
        socketRef.current = null;
        modeRef.current = null;
        if (stopRequestedSocketRef.current === socket) stopRequestedSocketRef.current = null;
        if (settlePendingStop) liveStopGateRef.current?.cancel(socket);
        detachSocket(socket);
        socket.close();
      }

      if (ownsActiveConnection) {
        liveDiagnosticsRef.current?.mark("session-stop");
        liveDiagnosticsRef.current = null;
      }
      try {
        await stopRecorder(socket ?? undefined);
      } catch {
        // Socket and media cleanup must finish even if the recorder could not flush.
      }
    },
    [stopRecorder]
  );

  const stop = useCallback((): Promise<LectureStopOutcome> => {
    if (stopPromiseRef.current) return stopPromiseRef.current;

    const operation: Promise<LectureStopOutcome> = (async (): Promise<LectureStopOutcome> => {
      const socket = socketRef.current;
      const mode = modeRef.current;
      const handshake = socket && liveHandshakeRef.current?.owner === socket
        ? liveHandshakeRef.current.state
        : null;
      const disposition = resolveLectureStopDisposition({
        mode,
        socket,
        liveHandshake: handshake,
        demoReady: socket !== null && demoReadySocketRef.current === socket,
        terminalOutcome: sessionOutcomeRef.current
      });

      if (disposition.kind === "return-terminal") return disposition.outcome;
      if (disposition.kind === "no-active-session") {
        return {
          status: "no-active-session",
          reason: "idle",
          message: "종료할 강연이 없습니다."
        };
      }
      if (disposition.kind === "cancel-before-streaming") {
        const stopGeneration = ++sessionGenerationRef.current;
        await shutDownConnection(true, socket ?? undefined);
        if (!isCurrentLectureSession(sessionGenerationRef.current, stopGeneration)) {
          return { status: "cancelled", reason: "superseded", message: "새 강연이 시작되어 이전 종료 요청을 취소했습니다." };
        }
        sessionOutcomeRef.current = null;
        dispatch({ type: "discard" });
        return {
          status: "cancelled-before-streaming",
          reason: disposition.mode === "live" ? "live-connecting" : "demo-connecting",
          message: disposition.mode === "live"
            ? "실시간 음성 전송이 시작되기 전에 연결 준비를 취소했습니다."
            : "데모 자막이 시작되기 전에 준비를 취소했습니다."
        };
      }
      if (disposition.kind === "transport-failed") {
        const outcome: LectureSessionOutcome = {
          status: "transport-error",
          reason: "socket",
          message: "자막 연결이 닫히는 중이라 종료 요청을 확인하지 못했습니다. 마지막 자막이 반영되지 않았을 수 있습니다."
        };
        await shutDownConnection(false, socket ?? undefined);
        sessionOutcomeRef.current = outcome;
        dispatch({ type: "error", message: outcome.message, outcome });
        return outcome;
      }

      if (!socket || !mode) {
        return {
          status: "no-active-session",
          reason: "idle",
          message: "종료할 강연이 없습니다."
        };
      }
      const stopGeneration = sessionGenerationRef.current;
      stopRequestedSocketRef.current = socket;
      sessionDeadlinesRef.current?.clearSession(socket, stopGeneration);
      dispatch({ type: "stopping" });
      let request: LiveStopRequest | null;
      let recorderStopped = mode === "demo";
      try {
        request = await beginLiveStopRequest(
          async () => {
            if (mode === "live") await stopRecorder(socket);
            if (preReadyPcmRef.current?.owner === socket) {
              preReadyPcmRef.current.queue.clear();
              preReadyPcmRef.current = null;
            }
            recorderStopped = true;
          },
          () =>
            socketRef.current === socket &&
            isCurrentLectureSession(sessionGenerationRef.current, stopGeneration) &&
            socket.readyState === WebSocket.OPEN,
          () =>
            liveStopGateRef.current?.wait(socket, async () => {
              const outcome: LectureSessionOutcome = {
                status: "flush-timeout",
                reason: "server-response-timeout",
                message: mode === "live"
                  ? "서버의 마지막 자막 확정 응답을 기다리는 시간이 초과되었습니다."
                  : "데모 자막 서버의 종료 응답을 기다리는 시간이 초과되었습니다."
              };
              sessionOutcomeRef.current = outcome;
              await shutDownConnection(false, socket, false);
              if (isCurrentLectureSession(sessionGenerationRef.current, stopGeneration)) {
                dispatch({ type: "error", message: outcome.message, outcome });
              }
            }) ?? Promise.resolve(),
          () => socket.send(JSON.stringify({ type: "stop" }))
        );
      } catch {
        const outcome: LectureSessionOutcome = recorderStopped
          ? {
              status: "transport-error",
              reason: "stop-request",
              message: "강연 종료 요청을 서버에 보내지 못했습니다."
            }
          : {
              status: "flush-timeout",
              reason: "client-flush-timeout",
              message: "마지막 마이크 오디오를 처리하지 못해 자막 일부가 빠졌을 수 있습니다."
            };
        liveStopGateRef.current?.cancel(socket);
        await shutDownConnection(false, socket, false);
        if (!isCurrentLectureSession(sessionGenerationRef.current, stopGeneration)) {
          return { status: "cancelled", reason: "superseded", message: "세션을 비워 이전 종료 결과를 폐기했습니다." };
        }
        sessionOutcomeRef.current = outcome;
        dispatch({ type: "error", message: outcome.message, outcome });
        return outcome;
      }
      if (!request) {
        const disposition = resolveMissingLiveStopRequestDisposition(socketRef.current !== socket);
        await shutDownConnection(false, socket);
        if (disposition && isCurrentLectureSession(sessionGenerationRef.current, stopGeneration)) {
          const outcome: LectureSessionOutcome = {
            status: "transport-error",
            reason: "socket",
            message: disposition.message
          };
          sessionOutcomeRef.current = outcome;
          dispatch({ type: disposition.status, message: disposition.message, outcome });
          return outcome;
        }
        if (!isCurrentLectureSession(sessionGenerationRef.current, stopGeneration)) {
          return { status: "cancelled", reason: "superseded", message: "새 강연이 시작되어 이전 종료 요청을 취소했습니다." };
        }
        return sessionOutcomeRef.current ?? {
          status: "cancelled",
          reason: "superseded",
          message: "종료 처리 중 세션 소유권이 바뀌었습니다."
        };
      }
      await request.waitForServer;
      if (!isCurrentLectureSession(sessionGenerationRef.current, stopGeneration)) {
        return { status: "cancelled", reason: "superseded", message: "새 강연이 시작되어 이전 종료 요청을 취소했습니다." };
      }
      return sessionOutcomeRef.current ?? {
        status: "transport-error",
        reason: "socket",
        message: "강연 종료 결과를 확인하지 못했습니다."
      };
    })();

    stopPromiseRef.current = operation;
    const clearOperation = () => {
      if (stopPromiseRef.current === operation) stopPromiseRef.current = null;
    };
    void operation.then(clearOperation, clearOperation);
    return operation;
  }, [shutDownConnection, stopRecorder]);

  const start = useCallback(
    async (mode: LectureMode, vocabularyName?: string): Promise<LectureStartOutcome> => {
      const sessionGeneration = ++sessionGenerationRef.current;
      await shutDownConnection(true);
      if (!isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration)) {
        return { status: "cancelled", reason: "superseded", message: "다른 강연 시작 요청으로 교체되었습니다." };
      }
      stopPromiseRef.current = null;
      sessionOutcomeRef.current = null;
      dispatch({ type: "starting", mode });

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socketResult = createLectureWebSocket(`${protocol}//${window.location.host}/ws`, createWebSocket);
      if (!socketResult.ok) {
        const outcome: LectureSessionOutcome = {
          status: "transport-error",
          reason: "socket-construction",
          message: "자막 서버 연결을 만들지 못했습니다. 페이지 주소와 네트워크 상태를 확인해 주세요."
        };
        sessionOutcomeRef.current = outcome;
        dispatch({ type: "error", message: outcome.message, outcome });
        return { status: "failed", outcome };
      }
      const socket = socketResult.socket;
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;
      const preReadyPcm = createPreReadyPcmQueue();
      preReadyPcmRef.current = mode === "live" ? { owner: socket, queue: preReadyPcm } : null;
      modeRef.current = mode;
      stopRequestedSocketRef.current = null;
      let liveHandshake = createLiveClientHandshakeState();
      liveHandshakeRef.current = mode === "live" ? { owner: socket, state: liveHandshake } : null;
      demoReadySocketRef.current = null;
      let liveFailureHandled = false;
      let legacyPartialRevision = 0;
      let recorderStartPromise: Promise<void> | null = null;
      const diagnostics =
        mode === "live"
          ? createDevelopmentLiveClientDiagnostics(import.meta.env.DEV, {
              sessionId: globalThis.crypto.randomUUID(),
              now: () => window.performance.now(),
              reporter: (record) => console.debug("[live-stt-diagnostic]", record)
            })
          : null;
      liveDiagnosticsRef.current = diagnostics;

      const updateLiveReadiness = (): void => {
        if (
          mode !== "live" ||
          stopRequestedSocketRef.current === socket ||
          socketRef.current !== socket ||
          !isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration)
        ) {
          return;
        }
        const readiness = resolveLiveHandshakeView(liveHandshake);
        dispatch(
          readiness.ready
            ? { type: "ready", message: readiness.message }
            : { type: "connection-progress", message: readiness.message }
        );
      };
      const failSession = (
        message: string,
        reason: Extract<LectureSessionOutcome, { status: "transport-error" }>["reason"] = "capture"
      ): void => {
        if (
          liveFailureHandled ||
          socketRef.current !== socket ||
          !isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration)
        ) {
          return;
        }
        liveFailureHandled = true;
        const terminal = transitionLiveClientHandshake(liveHandshake, { type: "terminal" });
        if (terminal.ok) liveHandshake = terminal.state;
        if (liveHandshakeRef.current?.owner === socket) {
          liveHandshakeRef.current = { owner: socket, state: liveHandshake };
        }
        preReadyPcm.clear();
        if (preReadyPcmRef.current?.owner === socket) preReadyPcmRef.current = null;
        sessionDeadlinesRef.current?.clearSession(socket, sessionGeneration);
        diagnostics?.mark("transport-failed");
        const outcome: LectureSessionOutcome = { status: "transport-error", reason, message };
        sessionOutcomeRef.current = outcome;
        dispatch({ type: "error", message, outcome });
        void shutDownConnection(false, socket, false).then(() => liveStopGateRef.current?.complete(socket));
      };
      const applyLiveHandshakeEvent = (event: LiveClientHandshakeEvent): boolean => {
        const transition = transitionLiveClientHandshake(liveHandshake, event);
        if (transition.ok === false) {
          failSession(transition.message, "protocol");
          return false;
        }
        liveHandshake = transition.state;
        if (liveHandshakeRef.current?.owner === socket) {
          liveHandshakeRef.current = { owner: socket, state: liveHandshake };
        }
        updateLiveReadiness();
        return true;
      };
      const enableAudioForwarding = (): boolean => {
        if (!canForwardLiveAudio(liveHandshake)) {
          failSession("서버가 오디오 전송을 승인하기 전에 전송 준비를 시도했습니다.", "protocol");
          return false;
        }
        const result = preReadyPcm.flush((audio) => sendLiveAudioChunk(socket, audio));
        if (preReadyPcmRef.current?.owner === socket) preReadyPcmRef.current = null;
        if (result === "flushed") return true;
        failSession(
          result === "backpressure"
            ? `음성인식 준비 중 보존한 ${LIVE_AUDIO_MAX_BUFFERED_LAG_MS / 1_000}초 오디오를 전송하기 전에 브라우저 전송 큐가 가득 찼습니다. 다시 시작해 주세요.`
            : "음성인식 준비 중 보존한 마이크 오디오를 서버로 보내지 못했습니다."
        );
        return false;
      };
      const startLiveRecorder = (): Promise<void> => {
        if (recorderStartPromise) return recorderStartPromise;
        recorderStartPromise = (async () => {
          try {
            const recorder = createRecorder();
            recorderRef.current = recorder;
            recorderOwnerRef.current = socket;
            await recorder.start(
              (audio) => {
                if (
                  socketRef.current !== socket ||
                  !isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration)
                ) {
                  return;
                }
                diagnostics?.recordPcm(audio.byteLength, socket.bufferedAmount);

                if (!canForwardLiveAudio(liveHandshake)) {
                  const queued = preReadyPcm.enqueue(audio);
                  if (queued === "overflow") {
                    failSession(
                      `음성인식 준비가 ${LIVE_AUDIO_MAX_BUFFERED_LAG_MS / 1_000}초 이상 지연되어 오래된 오디오를 버리지 않고 연결을 종료했습니다. 다시 시작해 주세요.`
                    );
                  }
                  return;
                }

                const result = sendLiveAudioChunk(socket, audio);
                if (result === "backpressure") {
                  failSession(
                    `음성 전송이 ${LIVE_AUDIO_MAX_BUFFERED_LAG_MS / 1_000}초 이상 밀려 오래된 오디오를 보내지 않고 연결을 종료했습니다. 다시 시작해 주세요.`
                  );
                } else if (result === "send-error") {
                  failSession("마이크 오디오를 서버로 보내지 못했습니다.");
                }
              },
              {
                onFirstPcm: () => {
                  if (
                    socketRef.current !== socket ||
                    stopRequestedSocketRef.current === socket ||
                    !isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration)
                  ) {
                    return;
                  }
                  if (!applyLiveHandshakeEvent({ type: "local-first-pcm" })) return;
                  sessionDeadlinesRef.current?.clear("first-pcm", socket, sessionGeneration);
                },
                onError: (error) => failSession(error.message)
              }
            );
            if (
              socketRef.current !== socket ||
              stopRequestedSocketRef.current === socket ||
              !isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration)
            ) {
              if (recorderRef.current === recorder) {
                recorderRef.current = null;
                if (recorderOwnerRef.current === socket) recorderOwnerRef.current = null;
              }
              await recorder.stop();
              return;
            }
            sessionDeadlinesRef.current?.clear("capture-permission", socket, sessionGeneration);
            try {
              socket.send(JSON.stringify({ type: "captureReady" }));
            } catch {
              failSession("마이크 준비 상태를 자막 서버로 보내지 못했습니다.", "start-request");
              return;
            }
            if (!applyLiveHandshakeEvent({ type: "local-capture-ready-sent" })) return;
            sessionDeadlinesRef.current?.arm(
              "start-handshake",
              socket,
              sessionGeneration,
              LIVE_START_HANDSHAKE_TIMEOUT_MS,
              () => failSession(
                "마이크는 준비됐지만 음성인식 서버가 오디오 전송을 승인하지 않았습니다. AWS 연결 상태를 확인해 주세요.",
                "start-handshake-timeout"
              )
            );
            diagnostics?.mark("recorder-running");
            if (!hasReceivedFirstPcm(liveHandshake)) {
              sessionDeadlinesRef.current?.arm(
                "first-pcm",
                socket,
                sessionGeneration,
                LIVE_FIRST_PCM_TIMEOUT_MS,
                () => failSession("마이크는 준비됐지만 PCM 오디오가 시작되지 않았습니다. 입력 장치를 확인해 주세요.")
              );
            }
          } catch (error) {
            if (
              error instanceof PcmRecorderStartCancelledError ||
              socketRef.current !== socket ||
              stopRequestedSocketRef.current === socket ||
              !isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration)
            ) {
              return;
            }
            failSession(error instanceof Error ? error.message : "마이크를 시작하지 못했습니다.");
          }
        })();
        return recorderStartPromise;
      };

      socket.onopen = () => {
        if (socketRef.current !== socket || !isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration)) return;
        sessionDeadlinesRef.current?.clear("socket-open", socket, sessionGeneration);
        diagnostics?.mark("websocket-open");
        try {
          socket.send(JSON.stringify(createLectureStartMessage(mode, terms, phraseSet, vocabularyName)));
          sessionDeadlinesRef.current?.arm(
            "start-handshake",
            socket,
            sessionGeneration,
            LIVE_START_HANDSHAKE_TIMEOUT_MS,
            () => {
              if (stopRequestedSocketRef.current === socket) return;
              failSession(
                mode === "live"
                  ? "음성인식 시작 응답 시간이 초과되었습니다. AWS 연결 상태를 확인한 뒤 다시 시작해 주세요."
                  : "데모 자막 시작 응답 시간이 초과되었습니다. 다시 시작해 주세요.",
                "start-handshake-timeout"
              );
            }
          );
        } catch {
          failSession("음성인식 시작 요청을 보내지 못했습니다.", "start-request");
          return;
        }
      };

      const handleServerEvent = (event: LectureStreamServerEvent): void => {
        if (shouldIgnoreLectureStreamEventAfterStop(event, stopRequestedSocketRef.current === socket)) return;

        if (event.type === "ready") {
          if (mode === "live") {
            failSession(
              "실시간 자막 서버가 지원하지 않는 이전 준비 신호를 보냈습니다. 서버와 클라이언트 버전을 맞춰 주세요.",
              "protocol"
            );
            return;
          }
          if (demoReadySocketRef.current === socket) {
            failSession("데모 준비 신호가 중복으로 도착했습니다.", "protocol");
            return;
          }
          sessionDeadlinesRef.current?.clear("start-handshake", socket, sessionGeneration);
          demoReadySocketRef.current = socket;
          dispatch({ type: "ready", message: event.message });
        } else if (event.type === "captureRequested") {
          if (mode !== "live") {
            failSession("데모 세션에 실시간 마이크 준비 신호가 도착했습니다.", "protocol");
            return;
          }
          if (!applyLiveHandshakeEvent({ type: "server-capture-requested" })) return;
          sessionDeadlinesRef.current?.clear("start-handshake", socket, sessionGeneration);
          sessionDeadlinesRef.current?.arm(
            "capture-permission",
            socket,
            sessionGeneration,
            LIVE_CAPTURE_PERMISSION_TIMEOUT_MS,
            () => failSession("마이크 권한 확인 시간이 초과되었습니다. 권한을 허용한 뒤 다시 시작해 주세요.")
          );
          dispatch({
            type: "connection-progress",
            message: event.message || "마이크 권한을 확인하고 있습니다."
          });
          void startLiveRecorder();
        } else if (event.type === "readyForAudio") {
          if (mode !== "live") {
            failSession("데모 세션에 오디오 전송 준비 신호가 도착했습니다.", "protocol");
            return;
          }
          if (!applyLiveHandshakeEvent({ type: "server-ready-for-audio" })) return;
          if (!enableAudioForwarding()) return;
          sessionDeadlinesRef.current?.clear("start-handshake", socket, sessionGeneration);
        } else if (event.type === "providerAccepted") {
          if (mode !== "live") {
            failSession("데모 세션에 음성인식 승인 신호가 도착했습니다.", "protocol");
            return;
          }
          if (!applyLiveHandshakeEvent({ type: "server-provider-accepted" })) return;
          sessionDeadlinesRef.current?.clear("start-handshake", socket, sessionGeneration);
          diagnostics?.mark("provider-ready");
        } else if (event.type === "status") {
          const alreadyReady = mode === "live"
            ? resolveLiveHandshakeView(liveHandshake).ready
            : demoReadySocketRef.current === socket;
          if (event.message && stopRequestedSocketRef.current !== socket && !alreadyReady) {
            dispatch({ type: "connection-progress", message: event.message });
          }
        } else if (event.type === "partial" || event.type === "interim") {
          const streamingStarted = mode === "live"
            ? hasLiveStreamingStarted(liveHandshake)
            : demoReadySocketRef.current === socket;
          if (!streamingStarted) {
            failSession("자막 스트림 준비가 끝나기 전에 자막 데이터가 도착했습니다.", "protocol");
            return;
          }
          diagnostics?.mark("first-interim");
          if ((event.text || "").trim()) captionTimingEstimatorRef.current?.markReceived("interim");
          dispatch({
            type: "partial",
            segmentId: event.segmentId || `legacy-${sessionGeneration}`,
            revision: event.revision ?? ++legacyPartialRevision,
            text: event.text || "",
            ...(event.type === "partial" && event.stablePrefixLength !== undefined
              ? { stablePrefixLength: event.stablePrefixLength }
              : {}),
            ...(event.type === "partial" && event.startTimeMs !== undefined ? { startTimeMs: event.startTimeMs } : {}),
            ...(event.type === "partial" && event.endTimeMs !== undefined ? { endTimeMs: event.endTimeMs } : {})
          });
        } else if (event.type === "final" && event.text?.trim()) {
          const streamingStarted = mode === "live"
            ? hasLiveStreamingStarted(liveHandshake)
            : demoReadySocketRef.current === socket;
          if (!streamingStarted) {
            failSession("자막 스트림 준비가 끝나기 전에 확정 자막이 도착했습니다.", "protocol");
            return;
          }
          diagnostics?.mark("first-final");
          captionTimingEstimatorRef.current?.markReceived("final");
          const { line, occurrenceTermIds } = createFinalTranscriptLine(event);
          dispatch({
            type: "final",
            segmentId: event.segmentId,
            revision: event.revision,
            line,
            occurrenceTermIds
          });
        } else if (event.type === "error") {
          failSession(event.message || "자막 서버에서 오류가 발생했습니다. 다시 시작해 주세요.", "server");
        } else if (event.type === "ended") {
          liveFailureHandled = true;
          const message = event.message || "강연이 끝났습니다.";
          const endedOutcome = resolveEndedEventOutcome(event);
          const outcome: LectureSessionOutcome =
            endedOutcome === "flush-timeout"
              ? {
                  status: "flush-timeout",
                  reason: "server-flush-timeout",
                  message
                }
              : {
                  status: "completed",
                  reason: "server-ended",
                  message
                };
          sessionOutcomeRef.current = outcome;
          void shutDownConnection(false, socket, false).then(() => {
            if (!isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration)) return;
            if (outcome.status === "completed") dispatch({ type: "ended", message, outcome });
            else dispatch({ type: "error", message, outcome });
            liveStopGateRef.current?.complete(socket);
          });
        }
      };

      socket.onmessage = (message) => {
        if (socketRef.current !== socket || !isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration)) return;
        handleLectureStreamSocketData(message.data, {
          onEvent: handleServerEvent,
          onProtocolError: (message) => failSession(message, "protocol")
        });
      };
      const handleTransportFailure = (source: SocketTransportFailureSource) => {
        handleSocketTransportFailure({
          source,
          isWaitingForServerEnd: liveStopGateRef.current?.isWaiting(socket) === true,
          isCurrent: () =>
            socketRef.current === socket && isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration),
          shutDown: () => {
            void shutDownConnection(false, socket, false);
          },
          dispatchError: (message) => {
            diagnostics?.mark("transport-failed");
            const outcome: LectureSessionOutcome = {
              status: "transport-error",
              reason: "socket",
              message
            };
            sessionOutcomeRef.current = outcome;
            dispatch({ type: "error", message, outcome });
          },
          completeStopGate: () => {
            liveStopGateRef.current?.complete(socket);
          }
        });
      };
      socket.onerror = () => handleTransportFailure("error");
      socket.onclose = () => handleTransportFailure("close");
      sessionDeadlinesRef.current?.arm(
        "socket-open",
        socket,
        sessionGeneration,
        LIVE_SOCKET_OPEN_TIMEOUT_MS,
        () => {
          if (stopRequestedSocketRef.current === socket) return;
          failSession(
            "자막 서버 연결 시간이 초과되었습니다. 네트워크 상태를 확인한 뒤 다시 시작해 주세요.",
            "socket-open-timeout"
          );
        }
      );
      return { status: "opening", mode };
    },
    [createRecorder, createWebSocket, phraseSet, shutDownConnection, terms]
  );

  const discardSession = useCallback((): void => {
    sessionGenerationRef.current += 1;
    sessionOutcomeRef.current = null;
    stopPromiseRef.current = null;
    sessionDeadlinesRef.current?.clearAll();
    dispatch({ type: "discard" });
    void shutDownConnection(true);
  }, [shutDownConnection]);

  useEffect(
    () => () => {
      sessionGenerationRef.current += 1;
      sessionDeadlinesRef.current?.clearAll();
      void shutDownConnection(true);
    },
    [shutDownConnection]
  );

  return { ...state, start, stop, discardSession };
}

import { useCallback, useEffect, useReducer, useRef } from "react";
import { PcmRecorder } from "../lib/pcm-recorder";
import type { GlossaryTerm, TranscriptEvent, TranscriptLine } from "../types";
import {
  createInitialLectureStreamState,
  createLectureStartMessage,
  isCurrentLectureSession,
  lectureStreamReducer,
  type LectureMode
} from "./lecture-stream-state";
import { createLiveStopGate, type LiveStopGate } from "./lecture-stop-gate";

function detachSocket(socket: WebSocket): void {
  socket.onopen = null;
  socket.onmessage = null;
  socket.onerror = null;
  socket.onclose = null;
}

type LiveStopRequest = {
  waitForServer: Promise<void>;
};

export const LIVE_PCM_BYTES_PER_SECOND = 16_000 * 1 * 2;
export const LIVE_AUDIO_MAX_BUFFERED_LAG_MS = 500;
export const LIVE_CAPTURE_READY_TIMEOUT_MS = 3_000;
export const LIVE_AUDIO_MAX_BUFFERED_BYTES =
  (LIVE_PCM_BYTES_PER_SECOND * LIVE_AUDIO_MAX_BUFFERED_LAG_MS) / 1_000;

type LiveAudioSocket = Pick<WebSocket, "bufferedAmount" | "readyState" | "send">;

export type LiveAudioSendResult = "preparing" | "sent" | "unavailable" | "backpressure" | "send-error";

export function sendLiveAudioChunk(
  socket: LiveAudioSocket,
  audio: ArrayBuffer,
  maxBufferedBytes = LIVE_AUDIO_MAX_BUFFERED_BYTES
): LiveAudioSendResult {
  if (socket.readyState !== WebSocket.OPEN) return "unavailable";
  if (socket.bufferedAmount + audio.byteLength > maxBufferedBytes) return "backpressure";
  try {
    socket.send(audio);
    return "sent";
  } catch {
    return "send-error";
  }
}

export function forwardLiveAudioChunk(
  providerReady: boolean,
  socket: LiveAudioSocket,
  audio: ArrayBuffer,
  maxBufferedBytes = LIVE_AUDIO_MAX_BUFFERED_BYTES
): LiveAudioSendResult {
  if (!providerReady) return "preparing";
  return sendLiveAudioChunk(socket, audio, maxBufferedBytes);
}

export type LiveReadiness = {
  providerReady: boolean;
  captureReady: boolean;
};

export function resolveLiveReadiness(readiness: LiveReadiness): { ready: boolean; message: string } {
  if (readiness.providerReady && readiness.captureReady) {
    return { ready: true, message: "마이크와 Google STT가 준비되었습니다." };
  }
  if (readiness.providerReady) return { ready: false, message: "마이크 입력을 확인하고 있습니다." };
  if (readiness.captureReady) return { ready: false, message: "Google STT 전송을 준비하고 있습니다." };
  return { ready: false, message: "마이크와 Google STT를 연결하고 있습니다." };
}

export type LiveClientDiagnosticStage =
  | "websocket-open"
  | "recorder-running"
  | "first-pcm"
  | "provider-ready"
  | "first-interim"
  | "first-final"
  | "transport-failed"
  | "session-stop";

export type LiveClientDiagnosticRecord = {
  sessionId: string;
  stage: LiveClientDiagnosticStage;
  elapsedMs: number;
  pcmChunkCount: number;
  pcmBytes: number;
  maxInterchunkGapMs: number;
  maxWebSocketBufferedAmount: number;
};

export type LiveClientDiagnostics = {
  mark: (stage: LiveClientDiagnosticStage) => void;
  recordPcm: (byteLength: number, webSocketBufferedAmount: number) => void;
};

export function createDevelopmentLiveClientDiagnostics(
  development: boolean,
  options: {
    sessionId: string;
    now: () => number;
    reporter: (record: LiveClientDiagnosticRecord) => void;
  }
): LiveClientDiagnostics | null {
  if (!development) return null;

  const startedAt = options.now();
  const reportedOnce = new Set<LiveClientDiagnosticStage>();
  let pcmChunkCount = 0;
  let pcmBytes = 0;
  let previousPcmAt: number | null = null;
  let maxInterchunkGapMs = 0;
  let maxWebSocketBufferedAmount = 0;

  const mark = (stage: LiveClientDiagnosticStage): void => {
    if (reportedOnce.has(stage)) return;
    reportedOnce.add(stage);
    options.reporter({
      sessionId: options.sessionId,
      stage,
      elapsedMs: Math.max(0, options.now() - startedAt),
      pcmChunkCount,
      pcmBytes,
      maxInterchunkGapMs,
      maxWebSocketBufferedAmount
    });
  };

  return {
    mark,
    recordPcm(byteLength, webSocketBufferedAmount) {
      const now = options.now();
      if (previousPcmAt !== null) maxInterchunkGapMs = Math.max(maxInterchunkGapMs, now - previousPcmAt);
      previousPcmAt = now;
      pcmChunkCount += 1;
      pcmBytes += byteLength;
      maxWebSocketBufferedAmount = Math.max(maxWebSocketBufferedAmount, webSocketBufferedAmount);
      mark("first-pcm");
    }
  };
}

export type CaptionTimingEventKind = "interim" | "final";

export type CaptionReceiveToAfterPaintEstimate = {
  sequenceId: number;
  eventKind: CaptionTimingEventKind;
  receivedAtMs: number;
  afterPaintEstimateAtMs: number;
  receiveToAfterPaintEstimateMs: number;
};

export type CaptionReceiveToAfterPaintEstimator = {
  markReceived: (eventKind: CaptionTimingEventKind) => number;
};

export function createCaptionReceiveToAfterPaintEstimator(options: {
  requestAnimationFrame: (callback: () => void) => void;
  scheduleAfterFrameTask: (callback: () => void) => void;
  now: () => number;
  reporter: (estimate: CaptionReceiveToAfterPaintEstimate) => void;
}): CaptionReceiveToAfterPaintEstimator {
  let sequenceId = 0;

  return {
    markReceived(eventKind) {
      const currentSequenceId = ++sequenceId;
      const receivedAtMs = options.now();

      options.requestAnimationFrame(() => {
        // rAF runs before a rendering opportunity. A following task is a useful
        // next-paint estimate, not proof that a particular frame was presented.
        options.scheduleAfterFrameTask(() => {
          const afterPaintEstimateAtMs = options.now();
          options.reporter({
            sequenceId: currentSequenceId,
            eventKind,
            receivedAtMs,
            afterPaintEstimateAtMs,
            receiveToAfterPaintEstimateMs: Math.max(0, afterPaintEstimateAtMs - receivedAtMs)
          });
        });
      });

      return currentSequenceId;
    }
  };
}

export function createDevelopmentCaptionReceiveToAfterPaintEstimator(
  development: boolean,
  options: Parameters<typeof createCaptionReceiveToAfterPaintEstimator>[0]
): CaptionReceiveToAfterPaintEstimator | null {
  return development ? createCaptionReceiveToAfterPaintEstimator(options) : null;
}

export type SocketTransportFailureSource = "error" | "close";

export type SocketTransportFailureDisposition = {
  status: "error";
  message: string;
  completeStopGate: boolean;
};

export function resolveSocketTransportFailureDisposition(
  source: SocketTransportFailureSource,
  isWaitingForServerEnd: boolean
): SocketTransportFailureDisposition {
  return {
    status: "error",
    message: isWaitingForServerEnd
      ? "강연 종료 중 자막 연결이 끊어졌습니다. 마지막 자막이 모두 반영되지 않았을 수 있습니다."
      : source === "error"
        ? "서버에 연결하지 못했습니다."
        : "자막 연결이 예기치 않게 종료되었습니다.",
    completeStopGate: isWaitingForServerEnd
  };
}

export function handleSocketTransportFailure(options: {
  source: SocketTransportFailureSource;
  isWaitingForServerEnd: boolean;
  isCurrent: () => boolean;
  shutDown: () => void;
  dispatchError: (message: string) => void;
  completeStopGate: () => void;
}): boolean {
  if (!options.isCurrent()) return false;

  const disposition = resolveSocketTransportFailureDisposition(options.source, options.isWaitingForServerEnd);
  options.shutDown();
  options.dispatchError(disposition.message);
  if (disposition.completeStopGate) options.completeStopGate();
  return true;
}

export function resolveMissingLiveStopRequestDisposition(
  terminalEventAlreadyHandled: boolean
): SocketTransportFailureDisposition | null {
  if (terminalEventAlreadyHandled) return null;
  return {
    status: "error",
    message: "강연 종료 중 자막 연결이 끊어졌습니다. 마지막 자막이 모두 반영되지 않았을 수 있습니다.",
    completeStopGate: false
  };
}

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

export function createFinalTranscriptLine(event: TranscriptEvent, id: string): {
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

export function useLectureStream(terms: GlossaryTerm[], phraseSet: string[]) {
  const [state, dispatch] = useReducer(lectureStreamReducer, undefined, createInitialLectureStreamState);
  const socketRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<PcmRecorder | null>(null);
  const sessionGenerationRef = useRef(0);
  const modeRef = useRef<LectureMode | null>(null);
  const stopRequestedSocketRef = useRef<WebSocket | null>(null);
  const stopPromiseRef = useRef<Promise<void> | null>(null);
  const liveStopGateRef = useRef<LiveStopGate | null>(null);
  const captionTimingEstimatorRef = useRef<CaptionReceiveToAfterPaintEstimator | null>(null);
  const liveDiagnosticsRef = useRef<LiveClientDiagnostics | null>(null);
  const captureReadyTimerRef = useRef<number | null>(null);
  if (!liveStopGateRef.current) liveStopGateRef.current = createLiveStopGate();

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

  const stopRecorder = useCallback(async () => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    try {
      await recorder?.stop();
    } catch {
      // Shutdown must still complete if the browser audio context is already gone.
    }
  }, []);

  const shutDownConnection = useCallback(
    async (notifyServer: boolean, expectedSocket?: WebSocket, settlePendingStop = true) => {
      const socket = expectedSocket || socketRef.current;
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

      liveDiagnosticsRef.current?.mark("session-stop");
      liveDiagnosticsRef.current = null;
      if (captureReadyTimerRef.current !== null) {
        window.clearTimeout(captureReadyTimerRef.current);
        captureReadyTimerRef.current = null;
      }
      await stopRecorder();
    },
    [stopRecorder]
  );

  const stop = useCallback((): Promise<void> => {
    if (stopPromiseRef.current) return stopPromiseRef.current;

    const operation = (async () => {
      const socket = socketRef.current;
      const mode = modeRef.current;

      if (mode !== "live" || !socket || socket.readyState !== WebSocket.OPEN) {
        const stopGeneration = ++sessionGenerationRef.current;
        await shutDownConnection(true);
        if (!isCurrentLectureSession(sessionGenerationRef.current, stopGeneration)) return;
        dispatch({ type: "ended", message: "강연을 종료했습니다." });
        return;
      }

      const stopGeneration = sessionGenerationRef.current;
      stopRequestedSocketRef.current = socket;
      dispatch({ type: "stopping" });
      let request: LiveStopRequest | null;
      try {
        request = await beginLiveStopRequest(
          stopRecorder,
          () =>
            socketRef.current === socket &&
            isCurrentLectureSession(sessionGenerationRef.current, stopGeneration) &&
            socket.readyState === WebSocket.OPEN,
          () =>
            liveStopGateRef.current?.wait(socket, async () => {
              await shutDownConnection(false, socket, false);
              if (isCurrentLectureSession(sessionGenerationRef.current, stopGeneration)) {
                dispatch({
                  type: "ended",
                  message: "강연을 종료했습니다. 서버 종료 응답 대기 시간이 초과되었습니다."
                });
              }
            }) ?? Promise.resolve(),
          () => socket.send(JSON.stringify({ type: "stop" }))
        );
      } catch {
        liveStopGateRef.current?.cancel(socket);
        await shutDownConnection(false, socket, false);
        if (isCurrentLectureSession(sessionGenerationRef.current, stopGeneration)) {
          dispatch({ type: "error", message: "강연 종료 요청을 보내지 못했습니다." });
        }
        return;
      }
      if (!request) {
        const disposition = resolveMissingLiveStopRequestDisposition(socketRef.current !== socket);
        await shutDownConnection(false, socket);
        if (disposition && isCurrentLectureSession(sessionGenerationRef.current, stopGeneration)) {
          dispatch({ type: disposition.status, message: disposition.message });
        }
        return;
      }
      await request.waitForServer;
    })();

    stopPromiseRef.current = operation;
    void operation.finally(() => {
      if (stopPromiseRef.current === operation) stopPromiseRef.current = null;
    });
    return operation;
  }, [shutDownConnection, stopRecorder]);

  const start = useCallback(
    async (mode: LectureMode) => {
      const sessionGeneration = ++sessionGenerationRef.current;
      await shutDownConnection(true);
      if (!isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration)) return;
      stopPromiseRef.current = null;
      dispatch({ type: "starting", mode });

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;
      modeRef.current = mode;
      stopRequestedSocketRef.current = null;
      const liveReadiness: LiveReadiness = { providerReady: false, captureReady: false };
      let liveFailureHandled = false;
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
        if (mode !== "live") return;
        const readiness = resolveLiveReadiness(liveReadiness);
        dispatch(
          readiness.ready
            ? { type: "ready", message: readiness.message }
            : { type: "connection-progress", message: readiness.message }
        );
      };
      const failLiveCapture = (message: string): void => {
        if (
          liveFailureHandled ||
          socketRef.current !== socket ||
          !isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration)
        ) {
          return;
        }
        liveFailureHandled = true;
        if (captureReadyTimerRef.current !== null) {
          window.clearTimeout(captureReadyTimerRef.current);
          captureReadyTimerRef.current = null;
        }
        diagnostics?.mark("transport-failed");
        dispatch({ type: "error", message });
        void shutDownConnection(false, socket, false);
      };
      const startLiveRecorder = (): Promise<void> => {
        if (recorderStartPromise) return recorderStartPromise;
        recorderStartPromise = (async () => {
          try {
            const recorder = new PcmRecorder();
            recorderRef.current = recorder;
            await recorder.start(
              (audio) => {
                if (
                  socketRef.current !== socket ||
                  !isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration) ||
                  stopRequestedSocketRef.current === socket
                ) {
                  return;
                }
                diagnostics?.recordPcm(audio.byteLength, socket.bufferedAmount);

                const result = forwardLiveAudioChunk(liveReadiness.providerReady, socket, audio);
                if (result === "backpressure") {
                  failLiveCapture(
                    `음성 전송이 ${LIVE_AUDIO_MAX_BUFFERED_LAG_MS / 1_000}초 이상 밀려 오래된 오디오를 보내지 않고 연결을 종료했습니다. 다시 시작해 주세요.`
                  );
                } else if (result === "send-error") {
                  failLiveCapture("마이크 오디오를 서버로 보내지 못했습니다.");
                }
              },
              {
                onFirstPcm: () => {
                  if (
                    socketRef.current !== socket ||
                    !isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration)
                  ) {
                    return;
                  }
                  liveReadiness.captureReady = true;
                  if (captureReadyTimerRef.current !== null) {
                    window.clearTimeout(captureReadyTimerRef.current);
                    captureReadyTimerRef.current = null;
                  }
                  updateLiveReadiness();
                },
                onError: (error) => failLiveCapture(error.message)
              }
            );
            diagnostics?.mark("recorder-running");
            if (!liveReadiness.captureReady) {
              captureReadyTimerRef.current = window.setTimeout(
                () => failLiveCapture("마이크 오디오가 시작되지 않았습니다. 마이크 권한과 입력 장치를 확인해 주세요."),
                LIVE_CAPTURE_READY_TIMEOUT_MS
              );
            }
            updateLiveReadiness();
            if (
              socketRef.current !== socket ||
              stopRequestedSocketRef.current === socket ||
              !isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration)
            ) {
              if (recorderRef.current === recorder) recorderRef.current = null;
              await recorder.stop();
            }
          } catch (error) {
            if (socketRef.current !== socket || !isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration)) return;
            failLiveCapture(error instanceof Error ? error.message : "마이크를 시작하지 못했습니다.");
          }
        })();
        return recorderStartPromise;
      };

      socket.onopen = () => {
        if (socketRef.current !== socket || !isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration)) return;
        diagnostics?.mark("websocket-open");
        try {
          socket.send(JSON.stringify(createLectureStartMessage(mode, terms, phraseSet)));
        } catch {
          failLiveCapture("음성인식 시작 요청을 보내지 못했습니다.");
          return;
        }
      };

      socket.onmessage = (message) => {
        if (socketRef.current !== socket || !isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration)) return;
        const event = JSON.parse(message.data as string) as TranscriptEvent;
        if (event.type === "ready") {
          if (mode === "live") {
            liveReadiness.providerReady = true;
            diagnostics?.mark("provider-ready");
            updateLiveReadiness();
            void startLiveRecorder();
          } else {
            dispatch({ type: "ready", message: event.message });
          }
        } else if (event.type === "interim") {
          diagnostics?.mark("first-interim");
          if ((event.text || "").trim()) captionTimingEstimatorRef.current?.markReceived("interim");
          dispatch({ type: "interim", text: event.text || "" });
        } else if (event.type === "final" && event.text?.trim()) {
          diagnostics?.mark("first-final");
          captionTimingEstimatorRef.current?.markReceived("final");
          const { line, occurrenceTermIds } = createFinalTranscriptLine(
            event,
            `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          );
          dispatch({ type: "final", line, occurrenceTermIds });
        } else if (event.type === "error") {
          dispatch({ type: "error", message: event.message });
          void shutDownConnection(false, socket, false).then(() => liveStopGateRef.current?.complete(socket));
        } else if (event.type === "ended") {
          void shutDownConnection(false, socket, false).then(() => {
            if (!isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration)) return;
            dispatch({ type: "ended", message: event.message });
            liveStopGateRef.current?.complete(socket);
          });
        }
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
          dispatchError: (message) => dispatch({ type: "error", message }),
          completeStopGate: () => {
            liveStopGateRef.current?.complete(socket);
          }
        });
      };
      socket.onerror = () => handleTransportFailure("error");
      socket.onclose = () => handleTransportFailure("close");
    },
    [phraseSet, shutDownConnection, terms]
  );

  useEffect(
    () => () => {
      sessionGenerationRef.current += 1;
      void shutDownConnection(true);
    },
    [shutDownConnection]
  );

  return { ...state, start, stop };
}

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
      termIds: [...new Set(occurrenceTermIds)],
      relatedPage: event.relatedPage
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
  if (!liveStopGateRef.current) liveStopGateRef.current = createLiveStopGate();

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

      socket.onopen = async () => {
        if (socketRef.current !== socket || !isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration)) return;
        socket.send(JSON.stringify(createLectureStartMessage(mode, terms, phraseSet)));
        if (mode === "live") {
          try {
            const recorder = new PcmRecorder();
            recorderRef.current = recorder;
            await recorder.start((audio) => {
              if (
                socketRef.current === socket &&
                isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration) &&
                stopRequestedSocketRef.current !== socket &&
                socket.readyState === WebSocket.OPEN
              ) {
                socket.send(audio);
              }
            });
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
            dispatch({ type: "error", message: error instanceof Error ? error.message : "마이크를 시작하지 못했습니다." });
            await shutDownConnection(false, socket);
          }
        }
      };

      socket.onmessage = (message) => {
        if (socketRef.current !== socket || !isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration)) return;
        const event = JSON.parse(message.data as string) as TranscriptEvent;
        if (event.type === "ready") {
          dispatch({ type: "ready", message: event.message });
        } else if (event.type === "interim") {
          dispatch({ type: "interim", text: event.text || "" });
        } else if (event.type === "final" && event.text) {
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

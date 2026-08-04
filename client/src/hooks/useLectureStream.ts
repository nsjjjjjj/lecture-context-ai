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

function detachSocket(socket: WebSocket): void {
  socket.onopen = null;
  socket.onmessage = null;
  socket.onerror = null;
  socket.onclose = null;
}

export function useLectureStream(terms: GlossaryTerm[], phraseSet: string[]) {
  const [state, dispatch] = useReducer(lectureStreamReducer, terms[0]?.id ?? null, createInitialLectureStreamState);
  const socketRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<PcmRecorder | null>(null);
  const sessionGenerationRef = useRef(0);

  const shutDownConnection = useCallback(async (notifyServer: boolean, expectedSocket?: WebSocket) => {
    const socket = expectedSocket || socketRef.current;
    if (socket && socketRef.current === socket) {
      if (notifyServer && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "stop" }));
      socketRef.current = null;
      detachSocket(socket);
      socket.close();
    }

    const recorder = recorderRef.current;
    recorderRef.current = null;
    try {
      await recorder?.stop();
    } catch {
      // Connection shutdown must still complete if the browser audio context is already gone.
    }
  }, []);

  const stop = useCallback(async () => {
    const stopGeneration = ++sessionGenerationRef.current;
    await shutDownConnection(true);
    if (!isCurrentLectureSession(sessionGenerationRef.current, stopGeneration)) return;
    dispatch({ type: "ended", message: "강연을 종료했습니다." });
  }, [shutDownConnection]);

  const start = useCallback(
    async (mode: LectureMode) => {
      const sessionGeneration = ++sessionGenerationRef.current;
      await shutDownConnection(true);
      if (!isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration)) return;
      dispatch({ type: "starting", mode, activeTermId: terms[0]?.id ?? null });

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;

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
                socket.readyState === WebSocket.OPEN
              ) {
                socket.send(audio);
              }
            });
            if (socketRef.current !== socket || !isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration)) {
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
          dispatch({ type: "interim", text: event.text || "", activeTermId: event.detectedTerms?.[0] });
        } else if (event.type === "final" && event.text) {
          const line: TranscriptLine = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            text: event.text,
            termIds: event.detectedTerms || [],
            relatedPage: event.relatedPage
          };
          dispatch({ type: "final", line, activeTermId: event.detectedTerms?.[0] });
        } else if (event.type === "error") {
          dispatch({ type: "error", message: event.message });
        } else if (event.type === "ended") {
          void shutDownConnection(false, socket).then(() => {
            if (!isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration)) return;
            dispatch({ type: "ended", message: event.message });
          });
        }
      };
      socket.onerror = () => {
        if (socketRef.current !== socket || !isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration)) return;
        dispatch({ type: "error", message: "서버에 연결하지 못했습니다." });
      };
      socket.onclose = () => {
        if (socketRef.current !== socket || !isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration)) return;
        void shutDownConnection(false, socket).then(() => {
          if (!isCurrentLectureSession(sessionGenerationRef.current, sessionGeneration)) return;
          dispatch({ type: "error", message: "자막 연결이 예기치 않게 종료되었습니다." });
        });
      };
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

  const setActiveTermId = useCallback((termId: string | null) => {
    dispatch({ type: "select-term", termId });
  }, []);

  return { ...state, setActiveTermId, start, stop };
}

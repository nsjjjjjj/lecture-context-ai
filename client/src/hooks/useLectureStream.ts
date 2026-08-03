import { useCallback, useEffect, useRef, useState } from "react";
import { PcmRecorder } from "../lib/pcm-recorder";
import type { GlossaryTerm, TranscriptEvent, TranscriptLine } from "../types";

type LectureMode = "live" | "demo";

export function useLectureStream(terms: GlossaryTerm[]) {
  const [status, setStatus] = useState<"idle" | "connecting" | "ready" | "ended" | "error">("idle");
  const [statusMessage, setStatusMessage] = useState("강연을 시작할 준비가 되었습니다.");
  const [interim, setInterim] = useState("");
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [activeTermId, setActiveTermId] = useState<string | null>(terms[0]?.id ?? null);
  const socketRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<PcmRecorder | null>(null);

  const stop = useCallback(async () => {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: "stop" }));
    socketRef.current?.close();
    socketRef.current = null;
    await recorderRef.current?.stop();
    recorderRef.current = null;
    setInterim("");
    setStatus("ended");
  }, []);

  const start = useCallback(
    async (mode: LectureMode) => {
      setStatus("connecting");
      setStatusMessage(mode === "demo" ? "데모 자막을 준비하고 있습니다." : "마이크와 Google STT를 연결하고 있습니다.");
      setLines([]);
      setInterim("");

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;

      socket.onopen = async () => {
        socket.send(JSON.stringify({ type: "start", mode, terms }));
        if (mode === "live") {
          try {
            const recorder = new PcmRecorder();
            recorderRef.current = recorder;
            await recorder.start((audio) => {
              if (socket.readyState === WebSocket.OPEN) socket.send(audio);
            });
          } catch (error) {
            setStatus("error");
            setStatusMessage(error instanceof Error ? error.message : "마이크를 시작하지 못했습니다.");
            socket.close();
          }
        }
      };

      socket.onmessage = (message) => {
        const event = JSON.parse(message.data as string) as TranscriptEvent;
        if (event.type === "ready") {
          setStatus("ready");
          setStatusMessage(event.message || "강연 중");
        } else if (event.type === "interim") {
          setInterim(event.text || "");
          if (event.detectedTerms?.[0]) setActiveTermId(event.detectedTerms[0]);
        } else if (event.type === "final" && event.text) {
          setInterim("");
          if (event.detectedTerms?.[0]) setActiveTermId(event.detectedTerms[0]);
          setLines((current) => [
            ...current,
            {
              id: `${Date.now()}-${current.length}`,
              text: event.text!,
              termIds: event.detectedTerms || [],
              relatedPage: event.relatedPage,
              latencyMs: event.latencyMs || 0
            }
          ]);
        } else if (event.type === "error") {
          setStatus("error");
          setStatusMessage(event.message || "자막 처리 중 오류가 발생했습니다.");
        } else if (event.type === "ended") {
          setStatus("ended");
          setStatusMessage(event.message || "강연이 끝났습니다.");
        }
      };
      socket.onerror = () => {
        setStatus("error");
        setStatusMessage("서버에 연결하지 못했습니다.");
      };
      socket.onclose = () => void recorderRef.current?.stop();
    },
    [terms]
  );

  useEffect(() => () => void stop(), [stop]);

  return { status, statusMessage, interim, lines, activeTermId, setActiveTermId, start, stop };
}

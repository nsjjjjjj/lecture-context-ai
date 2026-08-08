import "dotenv/config";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { createApp, resolveListenHost } from "./app.js";
import { type GlossaryTerm, type StartMessage, type TranscriptEvent } from "./types.js";
import { matchTerms } from "./services/glossary.js";
import { demoTranscript } from "./services/demo.js";
import {
  createGoogleSpeechSession,
  getGoogleSpeechConfigurationError,
  type SpeechSession
} from "./services/speech.js";
import { resolveStartContext } from "./services/ws-start.js";
import {
  clearPendingSpeechEnd,
  closeSpeechSessionForSocket,
  consumeSpeechEndMessage,
  requestLectureStop,
  type SpeechSessionSlot
} from "./services/ws-lifecycle.js";

const app = createApp();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const port = Number(process.env.PORT || 8787);
const host = resolveListenHost(process.env.NODE_ENV, process.env.HOST);

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (websocket) => wss.emit("connection", websocket, request));
});

function send(websocket: WebSocket, event: TranscriptEvent): void {
  if (websocket.readyState === WebSocket.OPEN) websocket.send(JSON.stringify(event));
}

function emitTranscript(websocket: WebSocket, text: string, isFinal: boolean, terms: GlossaryTerm[]): void {
  const matched = matchTerms(text, terms);
  send(websocket, {
    type: isFinal ? "final" : "interim",
    text,
    detectedTerms: matched.map((term) => term.id),
    relatedPage: matched[0]?.pageNumber
  });
}

function startDemo(websocket: WebSocket, terms: GlossaryTerm[], onEnd: () => void): Array<NodeJS.Timeout> {
  const timers: Array<NodeJS.Timeout> = [];
  send(websocket, { type: "ready", message: "데모 강연이 준비되었습니다." });
  demoTranscript.forEach((line, index) => {
    timers.push(
      setTimeout(() => emitTranscript(websocket, line.interim, false, terms), 700 + index * 2_350),
      setTimeout(() => emitTranscript(websocket, line.final, true, terms), 1_650 + index * 2_350)
    );
  });
  timers.push(setTimeout(onEnd, 1_650 + demoTranscript.length * 2_350));
  return timers;
}

wss.on("connection", (websocket) => {
  const speechSessionSlot: SpeechSessionSlot = { active: null, pendingEndMessage: null };
  let terms: GlossaryTerm[] = [];
  let started = false;
  let ended = false;
  let timers: Array<NodeJS.Timeout> = [];

  const endOnce = (message: string): void => {
    if (ended) return;
    ended = true;
    timers.forEach(clearTimeout);
    send(websocket, { type: "ended", message });
  };

  websocket.on("message", (data, isBinary) => {
    if (isBinary) {
      if (speechSessionSlot.active) speechSessionSlot.active.writeAudio(Buffer.from(data as Buffer));
      return;
    }

    try {
      const message = JSON.parse(data.toString()) as StartMessage | { type?: string };
      if (message.type === "stop") {
        requestLectureStop(speechSessionSlot, endOnce);
        return;
      }
      if (message.type !== "start" || started) return;

      const start = message as StartMessage;
      if (start.mode !== "live" && start.mode !== "demo") throw new Error("지원하지 않는 강연 모드입니다.");
      const context = resolveStartContext(start.mode, start.terms, start.phraseSet);
      terms = context.terms;
      started = true;

      if (start.mode === "demo") {
        timers = startDemo(websocket, terms, () => endOnce("데모 강연이 끝났습니다."));
        return;
      }

      const speechConfigurationError = getGoogleSpeechConfigurationError();
      if (speechConfigurationError) {
        send(websocket, { type: "error", message: `${speechConfigurationError} 데모 모드를 이용해 주세요.` });
        return;
      }

      let createdSession: SpeechSession | null = null;
      let sessionTerminated = false;
      createdSession = createGoogleSpeechSession(context.phraseSet, {
        onTranscript: (text, isFinal) => emitTranscript(websocket, text, isFinal, terms),
        onError: (error) => {
          sessionTerminated = true;
          if (speechSessionSlot.active === createdSession) speechSessionSlot.active = null;
          clearPendingSpeechEnd(speechSessionSlot);
          createdSession?.close();
          send(websocket, { type: "error", message: `음성인식 오류: ${error.message}` });
        },
        onEnd: () => {
          sessionTerminated = true;
          if (speechSessionSlot.active === createdSession) speechSessionSlot.active = null;
          endOnce(consumeSpeechEndMessage(speechSessionSlot, "Google STT 연결이 종료되었습니다."));
        }
      });
      if (sessionTerminated) {
        createdSession.close();
        return;
      }
      speechSessionSlot.active = createdSession;
      send(websocket, { type: "ready", message: "Google STT에 연결되었습니다." });
    } catch (error) {
      send(websocket, { type: "error", message: error instanceof Error ? error.message : "요청을 처리하지 못했습니다." });
    }
  });

  websocket.on("close", () => {
    ended = true;
    closeSpeechSessionForSocket(speechSessionSlot);
    timers.forEach(clearTimeout);
  });
});

server.listen(port, host, () => {
  console.log(`강연맥락 AI 서버가 http://${host}:${port} 에서 실행 중입니다.`);
});

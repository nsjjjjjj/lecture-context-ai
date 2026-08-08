import "dotenv/config";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { analyzeRequestSchema, type GlossaryTerm, type StartMessage, type TranscriptEvent } from "./types.js";
import { analyzeGlossary, matchTerms } from "./services/glossary.js";
import { demoPages, demoTerms, demoTranscript } from "./services/demo.js";
import {
  createGoogleSpeechSession,
  getGoogleSpeechConfigurationError,
  isGoogleSpeechConfigured,
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

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const port = Number(process.env.PORT || 8787);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, "../client");

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    services: {
      speech: isGoogleSpeechConfigured(),
      gemini: Boolean(process.env.GEMINI_API_KEY)
    }
  });
});

app.get("/api/demo", (_request, response) => {
  response.json({
    title: "생성형 AI 입문 강연",
    pages: demoPages,
    terms: demoTerms,
    phraseSet: demoTerms.map((term) => term.term),
    mode: "demo"
  });
});

app.post("/api/analyze", async (request, response) => {
  const parsed = analyzeRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "PDF 분석 요청 형식이 올바르지 않습니다.", issues: parsed.error.issues });
    return;
  }
  try {
    const result = await analyzeGlossary(parsed.data.title, parsed.data.pages);
    response.json(result);
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "PDF 분석에 실패했습니다." });
  }
});

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

if (process.env.NODE_ENV === "production") {
  app.use(express.static(clientDist, { index: false, maxAge: "1h" }));
  app.get("*splat", (_request, response) => response.sendFile(path.join(clientDist, "index.html")));
}

server.listen(port, () => {
  console.log(`강연맥락 AI 서버가 http://localhost:${port} 에서 실행 중입니다.`);
});

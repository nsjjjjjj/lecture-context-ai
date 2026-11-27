import "dotenv/config";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createApp, resolveListenHost } from "./app.js";
import {
  attachLectureWebSocketRuntime,
  DEFAULT_CAPTURE_PERMISSION_TIMEOUT_MS,
  DEFAULT_FIRST_AUDIO_TIMEOUT_MS
} from "./services/lecture-websocket.js";
import {
  createFixedWindowRateLimiter,
  isAllowedWebSocketOrigin,
  positiveEnvironmentInteger
} from "./services/ws-security.js";
import { WS_MAX_PAYLOAD_BYTES } from "./services/ws-protocol.js";

const app = createApp();
const server = http.createServer(app);
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: WS_MAX_PAYLOAD_BYTES,
  perMessageDeflate: false
});
const port = Number(process.env.PORT || 8787);
const host = resolveListenHost(process.env.NODE_ENV, process.env.HOST);

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

server.on("upgrade", (request, socket, head) => {
  let url: URL;
  try {
    url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  } catch {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  if (
    !isAllowedWebSocketOrigin({
      nodeEnv: process.env.NODE_ENV,
      host: request.headers.host,
      origin: request.headers.origin,
      remoteAddress: request.socket.remoteAddress,
      allowedOrigins: process.env.APP_ALLOWED_ORIGINS,
      forwardedProtocol: firstHeaderValue(request.headers["x-forwarded-proto"])
    })
  ) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (websocket) => wss.emit("connection", websocket, request));
});

wss.on("error", (error) => {
  console.error("[websocket-server]", error.message);
});

attachLectureWebSocketRuntime(wss, {
  nodeEnv: process.env.NODE_ENV,
  maxLiveSessions: positiveEnvironmentInteger(process.env.MAX_LIVE_STT_SESSIONS, 5),
  maxLiveSessionMs: positiveEnvironmentInteger(
    process.env.MAX_LIVE_STT_SESSION_MS,
    4 * 60 * 60 * 1_000
  ),
  maxConnections: positiveEnvironmentInteger(process.env.MAX_WS_CONNECTIONS, 100),
  startTimeoutMs: positiveEnvironmentInteger(process.env.WS_START_TIMEOUT_MS, 10_000),
  capturePermissionTimeoutMs: positiveEnvironmentInteger(
    process.env.WS_CAPTURE_PERMISSION_TIMEOUT_MS,
    DEFAULT_CAPTURE_PERMISSION_TIMEOUT_MS
  ),
  firstAudioTimeoutMs: positiveEnvironmentInteger(
    process.env.WS_FIRST_AUDIO_TIMEOUT_MS,
    DEFAULT_FIRST_AUDIO_TIMEOUT_MS
  ),
  audioIdleTimeoutMs: positiveEnvironmentInteger(process.env.WS_AUDIO_IDLE_TIMEOUT_MS, 30_000),
  trustProxy: process.env.TRUST_PROXY === "1",
  startLimiter: createFixedWindowRateLimiter({
    limit: positiveEnvironmentInteger(process.env.MAX_WS_STARTS_PER_MINUTE, 12),
    windowMs: 60_000
  })
});

export { server, wss };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(port, host, () => {
    console.log(`강연 용어 AI 서버가 http://${host}:${port} 에서 실행 중입니다.`);
  });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const client of wss.clients) client.close(1001, "server shutdown");
    server.close();
    const forceTimer = setTimeout(() => {
      for (const client of wss.clients) client.terminate();
      server.closeAllConnections();
    }, 10_000);
    forceTimer.unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler, type Request } from "express";
import { z } from "zod";
import { analyzeGlossary } from "./services/glossary.js";
import { demoPages, demoTerms } from "./services/demo.js";
import { isGoogleSpeechConfigured } from "./services/speech.js";
import {
  AudioFixtureError,
  AudioFixtureStore,
  FIXTURE_MAX_WAV_BYTES,
  fixtureEnvironmentSchema,
  fixtureSpeakerLabelSchema
} from "./services/audio-fixtures.js";
import { analyzeRequestSchema } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultClientDist = path.resolve(__dirname, "../client");
const defaultFixtureRoot = path.resolve(__dirname, "../../test-fixtures/stt");

const fixtureRequestSchema = z.object({
  scriptId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  speakerLabel: fixtureSpeakerLabelSchema,
  environment: fixtureEnvironmentSchema
}).strict();

type AppOptions = {
  nodeEnv?: string;
  fixtureRoot?: string;
  clientDist?: string;
};

export function resolveListenHost(nodeEnv: string | undefined, configuredHost: string | undefined): string {
  if (nodeEnv === "development") return "127.0.0.1";
  return configuredHost?.trim() || "0.0.0.0";
}

function normalizedHostname(value: string): string | null {
  try {
    return new URL(`http://${value}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

function originHostname(value: string): string | null {
  try {
    return new URL(value).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

function isLoopbackHostname(value: string | null): boolean {
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase().split("%")[0];
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

export function isLocalFixtureRequest(input: { remoteAddress?: string; host?: string; origin?: string }): boolean {
  if (!isLoopbackAddress(input.remoteAddress)) return false;
  if (!input.host || !isLoopbackHostname(normalizedHostname(input.host))) return false;
  return !input.origin || isLoopbackHostname(originHostname(input.origin));
}

function requestIsLocal(request: Request): boolean {
  const origin = request.get("origin");
  return isLocalFixtureRequest({
    remoteAddress: request.socket.remoteAddress,
    host: request.get("host"),
    ...(origin ? { origin } : {})
  });
}

const jsonErrorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  const status = error instanceof AudioFixtureError
    ? error.status
    : typeof error === "object" && error !== null && "status" in error && Number.isInteger(error.status)
      ? Number(error.status)
      : 500;
  const message = error instanceof AudioFixtureError
    ? error.message
    : status === 413
      ? "녹음 본문이 최대 120초 크기를 초과했습니다."
      : "요청을 처리하지 못했습니다.";
  response.status(status).json({ error: message });
};

export function createApp(options: AppOptions = {}) {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const app = express();

  app.disable("x-powered-by");
  const jsonParser = express.json({ limit: "2mb" });
  app.use((request, response, next) => {
    if (request.path === "/api/dev/audio-fixtures") {
      next();
      return;
    }
    jsonParser(request, response, next);
  });

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
      response.json(await analyzeGlossary(parsed.data.title, parsed.data.pages));
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : "PDF 분석에 실패했습니다." });
    }
  });

  if (nodeEnv === "development") {
    const store = new AudioFixtureStore(options.fixtureRoot ?? defaultFixtureRoot);
    const localOnly = (request: Request, response: express.Response, next: express.NextFunction): void => {
      if (!requestIsLocal(request)) {
        response.status(403).json({ error: "개발용 녹음 저장은 이 컴퓨터의 localhost에서만 사용할 수 있습니다." });
        return;
      }
      next();
    };

    app.get("/api/dev/audio-fixtures", localOnly, async (_request, response, next) => {
      try {
        response.json(await store.getCatalog());
      } catch (error) {
        next(error);
      }
    });

    app.post(
      "/api/dev/audio-fixtures",
      localOnly,
      (request, response, next) => {
        const mediaType = request.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        if (mediaType !== "audio/wav" && mediaType !== "audio/x-wav") {
          response.status(415).json({ error: "Content-Type이 audio/wav인 요청만 저장할 수 있습니다." });
          return;
        }
        next();
      },
      express.raw({ type: ["audio/wav", "audio/x-wav"], limit: FIXTURE_MAX_WAV_BYTES, inflate: false }),
      async (request, response, next) => {
        const parsed = fixtureRequestSchema.safeParse({
          scriptId: request.query.scriptId,
          speakerLabel: request.query.speakerLabel,
          environment: request.query.environment
        });
        if (!parsed.success || !Buffer.isBuffer(request.body)) {
          response.status(400).json({ error: "녹음 fixture 메타데이터 또는 WAV 본문 형식이 올바르지 않습니다." });
          return;
        }
        try {
          const recording = await store.save({ ...parsed.data, wav: request.body });
          response.status(201).json({ recording, storageDirectory: "test-fixtures/stt/audio" });
        } catch (error) {
          next(error);
        }
      }
    );
  }

  app.use("/api", (_request, response) => {
    response.status(404).json({ error: "API 경로를 찾을 수 없습니다." });
  });

  app.use(jsonErrorHandler);

  if (nodeEnv === "production") {
    const clientDist = options.clientDist ?? defaultClientDist;
    app.use(express.static(clientDist, { index: false, maxAge: "1h" }));
    app.get("*splat", (_request, response) => response.sendFile(path.join(clientDist, "index.html")));
  }

  return app;
}

import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { SttSession } from "./stt-session.js";

const originalSttProvider = process.env.STT_PROVIDER;

afterEach(() => {
  if (originalSttProvider === undefined) delete process.env.STT_PROVIDER;
  else process.env.STT_PROVIDER = originalSttProvider;
  vi.doUnmock("./speech.js");
  vi.resetModules();
});

describe("production Google Speech dependency boundary", () => {
  it("starts the production app as AWS even when the Google SDK module is unavailable", async () => {
    let googleModuleLoadCount = 0;
    vi.doMock("./speech.js", () => {
      googleModuleLoadCount += 1;
      throw new Error("Google SDK must not load in production");
    });
    vi.resetModules();
    process.env.STT_PROVIDER = "google";

    const [{ createApp }, websocketModule] = await Promise.all([
      import("../app.js"),
      import("./lecture-websocket.js")
    ]);
    expect(websocketModule.attachLectureWebSocketRuntime).toBeTypeOf("function");
    expect(googleModuleLoadCount).toBe(0);

    const server = createApp({ nodeEnv: "production" }).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, sttProvider: "aws" });
      expect(googleModuleLoadCount).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("loads the Google implementation only after an explicit development Google session starts", async () => {
    let googleModuleLoadCount = 0;
    const session: SttSession = {
      enqueueAudio: vi.fn(() => "accepted"),
      finishInput: vi.fn(),
      abort: vi.fn()
    };
    const createGoogleSpeechSession = vi.fn(async () => session);
    vi.doMock("./speech.js", () => {
      googleModuleLoadCount += 1;
      return { createGoogleSpeechSession };
    });
    vi.resetModules();

    const { attachLectureWebSocketRuntime } = await import("./lecture-websocket.js");
    expect(googleModuleLoadCount).toBe(0);

    const wss = new WebSocketServer({ port: 0 });
    const runtime = attachLectureWebSocketRuntime(wss, {
      nodeEnv: "development",
      resolveProvider: () => "google",
      getGoogleConfigurationError: () => null,
      firstAudioTimeoutMs: 1_000
    });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const address = wss.address() as AddressInfo;
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const events: Array<Record<string, unknown>> = [];
    client.on("message", (data) => events.push(JSON.parse(data.toString()) as Record<string, unknown>));

    try {
      await new Promise<void>((resolve, reject) => {
        client.once("open", resolve);
        client.once("error", reject);
      });
      client.send(JSON.stringify({ type: "start", mode: "live", terms: [], phraseSet: [] }));

      await vi.waitFor(() => {
        expect(events.some((event) => event.type === "captureRequested")).toBe(true);
      });
      expect(googleModuleLoadCount).toBe(0);
      expect(createGoogleSpeechSession).not.toHaveBeenCalled();

      client.send(JSON.stringify({ type: "captureReady" }));
      await vi.waitFor(() => {
        expect(events.some((event) => event.type === "readyForAudio")).toBe(true);
      });
      expect(googleModuleLoadCount).toBe(1);
      expect(createGoogleSpeechSession).toHaveBeenCalledOnce();
      expect(events.some((event) => event.type === "providerAccepted")).toBe(true);
    } finally {
      client.terminate();
      runtime.detach();
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });
});

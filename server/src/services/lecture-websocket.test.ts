import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { AwsTranscribeCallbacks } from "./aws-transcribe.js";
import {
  attachLectureWebSocketRuntime,
  DEFAULT_CAPTURE_PERMISSION_TIMEOUT_MS,
  DEFAULT_FIRST_AUDIO_TIMEOUT_MS,
  type LectureWebSocketRuntime
} from "./lecture-websocket.js";
import type { SttSession } from "./stt-session.js";

type Harness = {
  wss: WebSocketServer;
  runtime: LectureWebSocketRuntime;
  url: string;
  callbacks: () => AwsTranscribeCallbacks;
  session: SttSession;
  sessionCreateCount: () => number;
};

const harnesses: Harness[] = [];

async function createHarness(options: {
  autoAccept?: boolean;
  acceptSynchronously?: boolean;
  onFinish?: (callbacks: AwsTranscribeCallbacks) => void;
  capturePermissionTimeoutMs?: number;
  firstAudioTimeoutMs?: number;
  audioIdleTimeoutMs?: number;
} = {}): Promise<Harness> {
  let providerCallbacks: AwsTranscribeCallbacks | undefined;
  let sessionCreateCount = 0;
  const session: SttSession = {
    enqueueAudio: vi.fn(() => "accepted" as const),
    finishInput: vi.fn(() => {
      if (!providerCallbacks) throw new Error("provider callbacks unavailable");
      options.onFinish?.(providerCallbacks);
    }),
    abort: vi.fn()
  };
  const wss = new WebSocketServer({ port: 0 });
  const runtime = attachLectureWebSocketRuntime(wss, {
    nodeEnv: "test",
    startTimeoutMs: 1_000,
    capturePermissionTimeoutMs: options.capturePermissionTimeoutMs ?? 1_000,
    firstAudioTimeoutMs: options.firstAudioTimeoutMs ?? 1_000,
    audioIdleTimeoutMs: options.audioIdleTimeoutMs ?? 1_000,
    resolveProvider: () => "aws",
    getAwsConfigurationError: () => null,
    createAwsSession: (_vocabularyName, callbacks) => {
      sessionCreateCount += 1;
      providerCallbacks = callbacks;
      if (options.autoAccept !== false) {
        if (options.acceptSynchronously) callbacks.onProviderAccepted({});
        else queueMicrotask(() => callbacks.onProviderAccepted({}));
      }
      return session;
    }
  });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address() as AddressInfo;
  const harness: Harness = {
    wss,
    runtime,
    url: `ws://127.0.0.1:${address.port}`,
    callbacks: () => {
      if (!providerCallbacks) throw new Error("provider callbacks unavailable");
      return providerCallbacks;
    },
    session,
    sessionCreateCount: () => sessionCreateCount
  };
  harnesses.push(harness);
  return harness;
}

async function openClient(url: string): Promise<{
  client: WebSocket;
  events: Array<Record<string, unknown>>;
  closed: Promise<number>;
}> {
  const client = new WebSocket(url);
  const events: Array<Record<string, unknown>> = [];
  const closed = new Promise<number>((resolve) => client.on("close", resolve));
  client.on("message", (data) => events.push(JSON.parse(data.toString()) as Record<string, unknown>));
  await new Promise<void>((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  return { client, events, closed };
}

function startLive(client: WebSocket): void {
  client.send(JSON.stringify({ type: "start", mode: "live", terms: [], phraseSet: [] }));
}

async function startLiveThroughCapture(connection: Awaited<ReturnType<typeof openClient>>): Promise<void> {
  startLive(connection.client);
  await vi.waitFor(() => expect(connection.events.some((event) => event.type === "captureRequested")).toBe(true));
  connection.client.send(JSON.stringify({ type: "captureReady" }));
  await vi.waitFor(() => expect(connection.events.some((event) => event.type === "readyForAudio")).toBe(true));
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(async ({ wss, runtime }) => {
    runtime.detach();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }));
});

describe("lecture WebSocket state machine", () => {
  it("separates a bounded human permission window from the short first-PCM deadline", () => {
    expect(DEFAULT_CAPTURE_PERMISSION_TIMEOUT_MS).toBe(30_000);
    expect(DEFAULT_FIRST_AUDIO_TIMEOUT_MS).toBe(3_000);
  });

  it("drains a delayed final before a completed terminal event and releases resources once", async () => {
    const harness = await createHarness({
      onFinish: (callbacks) => {
        callbacks.onTranscript({
          text: "마지막 RAG 설명입니다.",
          isFinal: true,
          providerResultId: "result-final"
        });
        callbacks.onEnd({ flushTimedOut: false });
      }
    });
    const connection = await openClient(harness.url);
    await startLiveThroughCapture(connection);
    connection.client.send(Buffer.alloc(3_200));
    await vi.waitFor(() => expect(harness.session.enqueueAudio).toHaveBeenCalledOnce());
    connection.client.send(JSON.stringify({ type: "stop" }));

    await expect(connection.closed).resolves.toBe(1000);
    expect(harness.session.finishInput).toHaveBeenCalledOnce();
    expect(connection.events.map((event) => event.type)).toEqual([
      "captureRequested",
      "readyForAudio",
      "providerAccepted",
      "final",
      "ended"
    ]);
    expect(connection.events.at(-1)).toMatchObject({
      type: "ended",
      outcome: "completed",
      message: "강연을 종료했습니다."
    });
    expect(harness.runtime.activeLiveSessionCount()).toBe(0);
    expect(harness.runtime.activeConnectionCount()).toBe(0);
  });

  it("does not lose a providerAccepted callback fired synchronously by an adapter", async () => {
    const harness = await createHarness({ acceptSynchronously: true });
    const connection = await openClient(harness.url);

    await startLiveThroughCapture(connection);

    expect(connection.events.filter((event) => event.type === "providerAccepted")).toHaveLength(1);
    expect(connection.events.map((event) => event.type).slice(0, 3)).toEqual([
      "captureRequested",
      "readyForAudio",
      "providerAccepted"
    ]);
  });

  it("surfaces final-drain timeout as a typed terminal outcome and explicit message", async () => {
    const harness = await createHarness({
      onFinish: (callbacks) => callbacks.onEnd({ flushTimedOut: true })
    });
    const connection = await openClient(harness.url);
    await startLiveThroughCapture(connection);
    connection.client.send(Buffer.alloc(3_200));
    await vi.waitFor(() => expect(harness.session.enqueueAudio).toHaveBeenCalledOnce());
    connection.client.send(JSON.stringify({ type: "stop" }));

    await expect(connection.closed).resolves.toBe(1000);
    expect(connection.events.at(-1)).toMatchObject({
      type: "ended",
      outcome: "flush-timeout",
      message: expect.stringContaining("마지막 자막 확정 대기 시간이 초과")
    });
  });

  it("does not emit a late providerAccepted event after stop has entered draining", async () => {
    const harness = await createHarness({ autoAccept: false });
    const connection = await openClient(harness.url);
    await startLiveThroughCapture(connection);
    connection.client.send(Buffer.alloc(3_200));
    await vi.waitFor(() => expect(harness.session.enqueueAudio).toHaveBeenCalledOnce());
    connection.client.send(JSON.stringify({ type: "stop" }));
    await vi.waitFor(() => expect(harness.session.finishInput).toHaveBeenCalledOnce());

    harness.callbacks().onProviderAccepted({});
    harness.callbacks().onEnd({ flushTimedOut: false });
    await expect(connection.closed).resolves.toBe(1000);
    expect(connection.events.some((event) => event.type === "providerAccepted")).toBe(false);
  });

  it("stops before first PCM by aborting the paid provider without an empty finishInput", async () => {
    const harness = await createHarness();
    const connection = await openClient(harness.url);
    await startLiveThroughCapture(connection);

    connection.client.send(JSON.stringify({ type: "stop" }));

    await expect(connection.closed).resolves.toBe(1000);
    expect(harness.session.finishInput).not.toHaveBeenCalled();
    expect(harness.session.abort).toHaveBeenCalledOnce();
    expect(connection.events.at(-1)).toMatchObject({
      type: "ended",
      outcome: "completed",
      message: "강연을 종료했습니다."
    });
  });

  it("closes provider failures as terminal errors and releases the live slot", async () => {
    const harness = await createHarness();
    const connection = await openClient(harness.url);
    await startLiveThroughCapture(connection);

    const error = new Error("AccessDeniedException");
    error.name = "AccessDeniedException";
    harness.callbacks().onError(error);

    await expect(connection.closed).resolves.toBe(1011);
    expect(connection.events.at(-1)).toMatchObject({ type: "error" });
    expect(harness.runtime.activeLiveSessionCount()).toBe(0);
    expect(harness.runtime.activeConnectionCount()).toBe(0);
  });

  it("never reports an AWS provider end before local stop as completed", async () => {
    const harness = await createHarness();
    const connection = await openClient(harness.url);
    await startLiveThroughCapture(connection);

    harness.callbacks().onEnd({ flushTimedOut: false });

    await expect(connection.closed).resolves.toBe(1011);
    expect(connection.events.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("강연 종료 전에 끊어졌습니다")
    });
    expect(connection.events.some((event) => event.type === "ended")).toBe(false);
  });

  it("bounds microphone permission waiting without creating a paid provider session", async () => {
    const harness = await createHarness({ capturePermissionTimeoutMs: 25 });
    const connection = await openClient(harness.url);
    startLive(connection.client);

    await expect(connection.closed).resolves.toBe(1008);
    expect(connection.events).toContainEqual({
      type: "captureRequested",
      message: "마이크 권한을 확인하고 있습니다. 1초 안에 허용해 주세요."
    });
    expect(connection.events.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("마이크 준비 응답이 없어")
    });
    expect(harness.sessionCreateCount()).toBe(0);
    expect(harness.session.abort).not.toHaveBeenCalled();
    expect(harness.runtime.activeLiveSessionCount()).toBe(0);
  });

  it("lets the user stop during permission waiting without ever opening the provider", async () => {
    const harness = await createHarness();
    const connection = await openClient(harness.url);
    startLive(connection.client);
    await vi.waitFor(() => expect(connection.events.some((event) => event.type === "captureRequested")).toBe(true));

    connection.client.send(JSON.stringify({ type: "stop" }));

    await expect(connection.closed).resolves.toBe(1000);
    expect(connection.events.at(-1)).toMatchObject({
      type: "ended",
      outcome: "completed",
      message: "강연을 종료했습니다."
    });
    expect(harness.sessionCreateCount()).toBe(0);
    expect(harness.session.abort).not.toHaveBeenCalled();
  });

  it("uses a separate short timeout when captureReady is acknowledged but PCM never arrives", async () => {
    const harness = await createHarness({ firstAudioTimeoutMs: 25 });
    const connection = await openClient(harness.url);
    await startLiveThroughCapture(connection);

    await expect(connection.closed).resolves.toBe(1008);
    expect(connection.events.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("PCM 오디오가 도착하지 않아")
    });
    expect(harness.sessionCreateCount()).toBe(1);
    expect(harness.session.abort).toHaveBeenCalledOnce();
  });

  it("aborts a session when audio stops arriving after capture began", async () => {
    const harness = await createHarness({ audioIdleTimeoutMs: 25 });
    const connection = await openClient(harness.url);
    await startLiveThroughCapture(connection);
    connection.client.send(Buffer.alloc(3_200));
    await vi.waitFor(() => expect(harness.session.enqueueAudio).toHaveBeenCalledOnce());

    await expect(connection.closed).resolves.toBe(1008);
    expect(connection.events.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("오디오 전송이 중단")
    });
    expect(harness.session.abort).toHaveBeenCalledOnce();
  });

  it("rejects malformed 16-bit PCM after ready instead of forwarding it to AWS", async () => {
    const harness = await createHarness();
    const connection = await openClient(harness.url);
    await startLiveThroughCapture(connection);
    connection.client.send(Buffer.alloc(3));

    await expect(connection.closed).resolves.toBe(1008);
    expect(connection.events.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("완전한 샘플")
    });
    expect(harness.session.enqueueAudio).not.toHaveBeenCalled();
  });
});

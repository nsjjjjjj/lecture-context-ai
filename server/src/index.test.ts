import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { server, wss } from "./index.js";
import { WS_MAX_PAYLOAD_BYTES } from "./services/ws-protocol.js";

let websocketUrl = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  websocketUrl = `ws://127.0.0.1:${address.port}/ws`;
});

afterAll(async () => {
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function exchange(payload: string | Buffer): Promise<{
  events: Array<Record<string, unknown>>;
  closeCode: number;
}> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(websocketUrl, { headers: { Origin: websocketUrl.replace("ws://", "http://").replace(/\/ws$/u, "") } });
    const events: Array<Record<string, unknown>> = [];
    client.on("open", () => client.send(payload));
    client.on("message", (data) => events.push(JSON.parse(data.toString()) as Record<string, unknown>));
    client.on("error", reject);
    client.on("close", (closeCode) => resolve({ events, closeCode }));
  });
}

describe("WebSocket terminal state integration", () => {
  it("stop before start sends one typed terminal event and closes without starting a provider", async () => {
    const result = await exchange(JSON.stringify({ type: "stop" }));

    expect(result.closeCode).toBe(1000);
    expect(result.events).toEqual([{
      type: "ended",
      outcome: "completed",
      message: "강연을 종료했습니다."
    }]);
  });

  it("invalid protocol input sends an error and closes the socket", async () => {
    const result = await exchange(JSON.stringify({ type: "pause" }));

    expect(result.closeCode).toBe(1008);
    expect(result.events).toEqual([
      expect.objectContaining({ type: "error", message: expect.stringContaining("지원하지 않거나") })
    ]);
  });

  it("rejects audio sent before readyForAudio", async () => {
    const result = await exchange(Buffer.alloc(3_200));

    expect(result.closeCode).toBe(1008);
    expect(result.events).toEqual([
      expect.objectContaining({ type: "error", message: expect.stringContaining("준비가 되기 전에") })
    ]);
  });

  it("lets the WebSocket engine reject frames above the total payload cap", async () => {
    const result = await exchange(Buffer.alloc(WS_MAX_PAYLOAD_BYTES + 1));

    expect(result.closeCode).toBe(1009);
    expect(result.events).toEqual([]);
  });

  it("rejects a vocabulary name that does not match the sanitized lecture terms before AWS starts", async () => {
    const result = await exchange(JSON.stringify({
      type: "start",
      mode: "live",
      terms: [{
        id: "rag",
        term: "RAG",
        english: "",
        spokenAliases: ["래그"],
        easyExplanation: "검색 결과를 답변에 활용하는 방식",
        pageNumber: 1,
        occurrences: 1,
        source: "demo"
      }],
      phraseSet: ["RAG", "래그"],
      vocabularyName: "lecture-ko-0000000000000000"
    }));

    expect(result.closeCode).toBe(1008);
    expect(result.events).toEqual([
      expect.objectContaining({ type: "error", message: expect.stringContaining("일치하지 않습니다") })
    ]);
  });

  it("provider configuration failure is terminal instead of leaving an open socket", async () => {
    vi.stubEnv("AWS_TRANSCRIBE_PARTIAL_STABILITY", "invalid");
    const result = await exchange(JSON.stringify({ type: "start", mode: "live", terms: [], phraseSet: [] }));
    vi.unstubAllEnvs();

    expect(result.closeCode).toBe(1011);
    expect(result.events).toEqual([
      expect.objectContaining({ type: "error" })
    ]);
  });
});

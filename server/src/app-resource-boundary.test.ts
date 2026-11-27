import http, { type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type AppOptions } from "./app.js";

const servers: Server[] = [];

async function listen(options: AppOptions = {}): Promise<string> {
  const server = http.createServer(createApp({
    nodeEnv: "test",
    prepareAwsVocabulary: vi.fn(async () => ({ vocabularyName: "unused", hash: "unused", reused: true })),
    ...options
  }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test port unavailable");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("paid API resource boundaries", () => {
  it("health는 외부 AWS 호출 없이 설정과 동작 검증 상태를 분리해 보고한다", async () => {
    const baseUrl = await listen();
    const response = await fetch(`${baseUrl}/api/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      sttProvider: "aws",
      services: {
        speech: { configured: expect.any(Boolean), verification: "unverified" },
        customVocabulary: { configured: expect.any(Boolean), verification: "unverified" },
        gemini: expect.any(Boolean)
      }
    });
  });

  it("rate-limits analyze before starting external analysis work", async () => {
    const baseUrl = await listen({
      analyzeRateLimiter: { take: () => ({ allowed: false, retryAfterSeconds: 17 }) }
    });
    const response = await fetch(`${baseUrl}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "자료", pages: [{ pageNumber: 1, text: "RAG" }] })
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
  });

  it("client가 analyze 연결을 끊으면 외부 분석 signal을 취소한다", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let observedSignal: AbortSignal | undefined;
    const analyzeGlossary: NonNullable<AppOptions["analyzeGlossary"]> = (
      _title,
      _pages,
      options = {}
    ) => {
      observedSignal = options.signal;
      markStarted?.();
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });
    };
    const baseUrl = await listen({ analyzeGlossary });
    const url = new URL("/api/analyze", baseUrl);
    const request = http.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    request.on("error", () => undefined);
    request.end(JSON.stringify({ title: "자료", pages: [{ pageNumber: 1, text: "RAG 자료입니다" }] }));
    await started;

    request.destroy();

    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
  });

  it("rate-limits custom vocabulary preparation before AWS work", async () => {
    const prepareAwsVocabulary = vi.fn(async () => ({ vocabularyName: "unused", hash: "unused", reused: true }));
    const baseUrl = await listen({
      prepareAwsVocabulary,
      vocabularyRateLimiter: { take: () => ({ allowed: false, retryAfterSeconds: 9 }) }
    });
    const response = await fetch(`${baseUrl}/api/vocabulary/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ terms: [] })
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("9");
    expect(prepareAwsVocabulary).not.toHaveBeenCalled();
  });

  it("client가 vocabulary 준비 연결을 끊으면 AWS 작업 signal을 취소한다", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let observedSignal: AbortSignal | undefined;
    const prepareAwsVocabulary: NonNullable<AppOptions["prepareAwsVocabulary"]> = (
      _terms,
      options = {}
    ) => {
      observedSignal = options.signal;
      markStarted?.();
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });
    };
    const baseUrl = await listen({ prepareAwsVocabulary });
    const url = new URL("/api/vocabulary/prepare", baseUrl);
    const request = http.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    request.on("error", () => undefined);
    request.end(JSON.stringify({
      terms: [{
        id: "rag",
        term: "RAG",
        english: "Retrieval-Augmented Generation",
        spokenAliases: ["래그"],
        easyExplanation: "검색 결과를 답변에 활용하는 방식",
        pageNumber: 1,
        occurrences: 1,
        source: "demo"
      }]
    }));
    await started;

    request.destroy();

    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
  });

  it("rejects analyze text over 600,000 characters before Gemini", async () => {
    const baseUrl = await listen();
    const pages = Array.from({ length: 8 }, (_, index) => ({
      pageNumber: index + 1,
      text: "A".repeat(index === 7 ? 40_001 : 80_000)
    }));
    const response = await fetch(`${baseUrl}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "큰 자료", pages })
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("60만 자") });
  });

  it("rejects duplicate, reordered, or skipped PDF page numbers before analysis", async () => {
    const analyzeGlossary = vi.fn();
    const baseUrl = await listen({ analyzeGlossary });

    for (const pageNumbers of [[1, 1], [2, 1], [1, 3]]) {
      const response = await fetch(`${baseUrl}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "잘못된 페이지",
          pages: pageNumbers.map((pageNumber) => ({ pageNumber, text: "페이지" }))
        })
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        issues: expect.arrayContaining([
          expect.objectContaining({ message: expect.stringContaining("1부터 순서대로") })
        ])
      });
    }
    expect(analyzeGlossary).not.toHaveBeenCalled();
  });

  it("rejects JSON bodies over the shared 2MB parser limit", async () => {
    const baseUrl = await listen();
    const response = await fetch(`${baseUrl}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(2 * 1_024 * 1_024) })
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("크기 제한") });
  });
});

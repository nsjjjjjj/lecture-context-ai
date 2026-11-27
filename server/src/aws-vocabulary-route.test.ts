import http, { type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { AwsVocabularyPreparationError } from "./services/aws-vocabulary.js";

const servers: Server[] = [];

async function listen(options: Parameters<typeof createApp>[0] = {}): Promise<string> {
  const server = http.createServer(
    createApp({
      nodeEnv: "test",
      prepareAwsVocabulary: vi.fn(async () => ({
        vocabularyName: "lecture-ko-1234567890abcdef",
        hash: "1234567890abcdef",
        reused: true
      })),
      ...options
    })
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test port unavailable");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("POST /api/vocabulary/prepare", () => {
  it("검증한 용어만 manager에 넘기고 content-addressed vocabulary를 반환한다", async () => {
    const baseUrl = await listen();
    const response = await fetch(`${baseUrl}/api/vocabulary/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        terms: [
          {
            id: "rag",
            term: "RAG",
            english: "Retrieval-Augmented Generation",
            spokenAliases: ["래그"],
            easyExplanation: "외부 문서를 검색해 답변하는 방식",
            pageNumber: 1,
            occurrences: 1,
            source: "demo"
          }
        ]
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ vocabularyName: "lecture-ko-1234567890abcdef" });
  });

  it("빈 용어 목록은 AWS 호출 전에 거부한다", async () => {
    const baseUrl = await listen();
    const response = await fetch(`${baseUrl}/api/vocabulary/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ terms: [] })
    });
    expect(response.status).toBe(400);
  });

  it("WebSocket과 같은 sanitizer를 거쳐 위험한 발음 별칭을 AWS에 보내지 않는다", async () => {
    const prepareAwsVocabulary = vi.fn(async () => ({
      vocabularyName: "lecture-ko-1234567890abcdef",
      hash: "1234567890abcdef",
      reused: true
    }));
    const baseUrl = await listen({ prepareAwsVocabulary });
    const response = await fetch(`${baseUrl}/api/vocabulary/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        terms: [{
          id: "api",
          term: "API",
          english: "Application Programming Interface",
          spokenAliases: ["사과", "에이피아이"],
          easyExplanation: "프로그램끼리 통신하는 규칙",
          pageNumber: 1,
          occurrences: 1,
          source: "demo"
        }]
      })
    });

    expect(response.status).toBe(200);
    expect(prepareAwsVocabulary).toHaveBeenCalledWith(
      [expect.objectContaining({ spokenAliases: ["에이피아이"] })],
      { signal: expect.any(AbortSignal) }
    );
  });

  it("서버 설정 오류를 사용자 입력 422가 아닌 503으로 반환한다", async () => {
    const baseUrl = await listen({
      prepareAwsVocabulary: vi.fn(async () => {
        throw new AwsVocabularyPreparationError(
          "NOT_CONFIGURED",
          "AWS_TRANSCRIBE_VOCABULARY_BUCKET 설정이 필요합니다."
        );
      })
    });
    const response = await fetch(`${baseUrl}/api/vocabulary/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        terms: [{
          id: "rag",
          term: "RAG",
          english: "",
          spokenAliases: ["래그"],
          easyExplanation: "검색 결과를 답변에 활용하는 방식",
          pageNumber: 1,
          occurrences: 1,
          source: "demo"
        }]
      })
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "NOT_CONFIGURED", retryable: false });
  });

  it("AWS 준비 timeout을 재시도 가능한 504로 반환한다", async () => {
    const baseUrl = await listen({
      prepareAwsVocabulary: vi.fn(async () => {
        throw new AwsVocabularyPreparationError(
          "UPSTREAM_TIMEOUT",
          "AWS 사용자 지정 용어집 준비 시간이 초과되었습니다."
        );
      })
    });
    const response = await fetch(`${baseUrl}/api/vocabulary/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        terms: [{
          id: "rag",
          term: "RAG",
          english: "",
          spokenAliases: ["래그"],
          easyExplanation: "검색 결과를 답변에 활용하는 방식",
          pageNumber: 1,
          occurrences: 1,
          source: "demo"
        }]
      })
    });

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({ code: "UPSTREAM_TIMEOUT", retryable: true });
  });
});

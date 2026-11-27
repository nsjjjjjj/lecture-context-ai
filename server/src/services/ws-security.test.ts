import { describe, expect, it } from "vitest";
import {
  createFixedWindowRateLimiter,
  isAllowedWebSocketOrigin,
  parseAllowedOrigins,
  positiveEnvironmentInteger,
  resolveClientAddress
} from "./ws-security.js";

describe("WebSocket origin policy", () => {
  it("production에서는 same-origin 또는 명시적 allowlist만 허용한다", () => {
    expect(isAllowedWebSocketOrigin({ nodeEnv: "production", host: "lecture.example", origin: "https://lecture.example" })).toBe(true);
    expect(
      isAllowedWebSocketOrigin({
        nodeEnv: "production",
        host: "lecture.example",
        origin: "https://controller.example",
        allowedOrigins: "https://controller.example"
      })
    ).toBe(true);
    expect(isAllowedWebSocketOrigin({ nodeEnv: "production", host: "lecture.example" })).toBe(false);
    expect(isAllowedWebSocketOrigin({ nodeEnv: "production", host: "lecture.example", origin: "https://evil.example" })).toBe(false);
    expect(isAllowedWebSocketOrigin({ nodeEnv: "production", host: "lecture.example", origin: "http://lecture.example" })).toBe(false);
    expect(isAllowedWebSocketOrigin({
      nodeEnv: "production",
      host: "lecture.example",
      origin: "http://lecture.example",
      forwardedProtocol: "http"
    })).toBe(true);
  });

  it("development에서는 loopback CLI와 Vite origin을 허용한다", () => {
    expect(
      isAllowedWebSocketOrigin({
        nodeEnv: "development",
        host: "127.0.0.1:8787",
        remoteAddress: "::ffff:127.0.0.1"
      })
    ).toBe(true);
    expect(
      isAllowedWebSocketOrigin({
        nodeEnv: "development",
        host: "127.0.0.1:8787",
        origin: "http://localhost:5173",
        remoteAddress: "127.0.0.1"
      })
    ).toBe(true);
  });

  it("환경 변수 파싱에서 빈 origin과 잘못된 수를 제거한다", () => {
    expect([...parseAllowedOrigins("https://one.example/, ,https://two.example")]).toEqual([
      "https://one.example",
      "https://two.example"
    ]);
    expect(positiveEnvironmentInteger("3", 5)).toBe(3);
    expect(positiveEnvironmentInteger("oops", 5)).toBe(5);
  });
});

describe("bounded fixed-window rate limiting", () => {
  it("rejects calls over the limit and resets after the window", () => {
    let now = 1_000;
    const limiter = createFixedWindowRateLimiter({ limit: 2, windowMs: 10_000, now: () => now });

    expect(limiter.take("client").allowed).toBe(true);
    expect(limiter.take("client").allowed).toBe(true);
    expect(limiter.take("client")).toEqual({ allowed: false, retryAfterSeconds: 10 });
    now = 11_000;
    expect(limiter.take("client").allowed).toBe(true);
  });

  it("uses forwarded addresses only behind an explicitly trusted proxy", () => {
    expect(resolveClientAddress({ remoteAddress: "10.0.0.2", forwardedFor: "203.0.113.7", trustProxy: false }))
      .toBe("10.0.0.2");
    expect(resolveClientAddress({ remoteAddress: "10.0.0.2", forwardedFor: "203.0.113.7, 10.0.0.2", trustProxy: true }))
      .toBe("203.0.113.7");
  });
});

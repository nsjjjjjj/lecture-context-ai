import { describe, expect, it } from "vitest";
import { resolveSttProvider, unverifiedServiceConfiguration } from "./aws-config.js";

describe("STT provider boundary", () => {
  it("uses AWS outside local development even if the legacy Google toggle is present", () => {
    expect(resolveSttProvider("google", "production")).toBe("aws");
    expect(resolveSttProvider("google", "test")).toBe("aws");
    expect(resolveSttProvider("google", undefined)).toBe("aws");
  });

  it("keeps Google only for explicit local comparison work", () => {
    expect(resolveSttProvider("google", "development")).toBe("google");
    expect(resolveSttProvider("aws", "development")).toBe("aws");
    expect(resolveSttProvider("typo", "development")).toBe("aws");
  });
});

describe("AWS health configuration semantics", () => {
  it("설정 감지를 AWS 동작 검증 성공으로 표현하지 않는다", () => {
    expect(unverifiedServiceConfiguration(true)).toEqual({
      configured: true,
      verification: "unverified"
    });
    expect(unverifiedServiceConfiguration(false)).toEqual({
      configured: false,
      verification: "unverified"
    });
  });
});

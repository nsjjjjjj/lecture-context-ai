import { describe, expect, it } from "vitest";
import { DEFAULT_LOCAL_API_PORT, resolveLocalApiPort } from "../../../vite.config";

describe("local API development port", () => {
  it("uses the same 8787 default as the local Node server", () => {
    expect(DEFAULT_LOCAL_API_PORT).toBe(8787);
    expect(resolveLocalApiPort(undefined)).toBe(8787);
  });

  it("derives the proxy port from a valid PORT value and rejects unusable values", () => {
    expect(resolveLocalApiPort("9090")).toBe(9090);
    expect(resolveLocalApiPort("0")).toBe(DEFAULT_LOCAL_API_PORT);
    expect(resolveLocalApiPort("not-a-port")).toBe(DEFAULT_LOCAL_API_PORT);
  });
});

import { describe, expect, it } from "vitest";
import { editDistance, errorRate } from "./compare-aws-stability.js";

describe("AWS stability comparison metrics", () => {
  it("character/word edit distance와 empty reference를 결정적으로 계산한다", () => {
    expect(editDistance(["R", "A", "G"], ["R", "G"])).toBe(1);
    expect(errorRate(["검색", "증강"], ["검색", "생성"])).toBe(0.5);
    expect(errorRate([], [])).toBe(0);
    expect(errorRate([], ["extra"])).toBe(1);
  });
});

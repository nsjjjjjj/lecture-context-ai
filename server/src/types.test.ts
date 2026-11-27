import { describe, expect, it } from "vitest";
import { analyzeRequestSchema } from "./types.js";

describe("analyze request page sequence", () => {
  it("1부터 유일하고 오름차순으로 연속된 페이지를 허용한다", () => {
    expect(analyzeRequestSchema.safeParse({
      pages: [
        { pageNumber: 1, text: "첫 페이지" },
        { pageNumber: 2, text: "둘째 페이지" }
      ]
    }).success).toBe(true);
  });

  it.each([
    ["중복", [1, 1]],
    ["역순", [2, 1]],
    ["누락", [1, 3]]
  ])("%s 페이지 번호를 거부한다", (_label, pageNumbers) => {
    const parsed = analyzeRequestSchema.safeParse({
      pages: pageNumbers.map((pageNumber) => ({ pageNumber, text: "페이지" }))
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toContainEqual(expect.objectContaining({
      path: expect.arrayContaining(["pages", "pageNumber"]),
      message: expect.stringContaining("1부터 순서대로")
    }));
  });
});

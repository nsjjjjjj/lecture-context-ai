import { describe, expect, it } from "vitest";
import { combinePdfTextFragments, type PdfTextFragment } from "./pdf";

function fragment(
  str: string,
  x: number,
  y: number,
  width: number,
  overrides: Partial<PdfTextFragment> = {}
): PdfTextFragment {
  return {
    str,
    dir: "ltr",
    transform: [10, 0, 0, 10, x, y],
    width,
    height: 10,
    hasEOL: false,
    ...overrides
  };
}

describe("combinePdfTextFragments", () => {
  it("인접한 PDF 조각 사이에 단어 내부 공백을 만들지 않는다", () => {
    expect(combinePdfTextFragments([
      fragment("거릅", 0, 100, 20, { hasEOL: true }),
      fragment("니다", 20.15, 100, 20)
    ])).toBe("거릅니다");
  });

  it("실제 발표 PDF의 줄 안쪽에서 잘린 한국어 활용형을 복원한다", () => {
    expect(combinePdfTextFragments([
      fragment("발음 별칭은 안전 규칙으로 거릅", 510.125, 248.39999999999998, 180.00029683072023, {
        transform: [12.9999984, 0, 0, 12.9999984, 510.125, 248.39999999999998],
        height: 12.9999984,
        hasEOL: true
      }),
      fragment("니다", 587.2499, 230.39999999999998, 25.750396830720014, {
        transform: [12.9999984, 0, 0, 12.9999984, 587.2499, 230.39999999999998],
        height: 12.9999984
      })
    ])).toBe("발음 별칭은 안전 규칙으로 거릅니다");
  });

  it("실제 단어 간 좌표 간격과 줄바꿈은 공백으로 보존한다", () => {
    expect(combinePdfTextFragments([
      fragment("AWS", 0, 100, 24),
      fragment("Transcribe", 29, 100, 70, { hasEOL: true }),
      fragment("실시간", 0, 80, 30),
      fragment("자막", 34, 80, 20)
    ])).toBe("AWS Transcribe 실시간 자막");
  });

  it("줄이 바뀌어도 독립된 한국어 단어는 합치지 않는다", () => {
    expect(combinePdfTextFragments([
      fragment("PDF에서 텍스트를", 67.25, 266.4, 105.751, { hasEOL: true }),
      fragment("읽습니다", 94.5, 248.4, 51.251)
    ])).toBe("PDF에서 텍스트를 읽습니다");
  });

  it("명시적 공백은 보존하고 좌표가 없는 조각은 보수적으로 분리한다", () => {
    expect(combinePdfTextFragments([
      { str: "생성형 " },
      { str: "AI" },
      { str: "RAG" }
    ])).toBe("생성형 AI RAG");
  });

  it("같은 기준선에서 좌표가 크게 되감긴 별도 텍스트 런을 분리한다", () => {
    expect(combinePdfTextFragments([
      fragment("왼쪽", 100, 100, 30),
      fragment("오른쪽", 10, 100, 40)
    ])).toBe("왼쪽 오른쪽");
  });
});

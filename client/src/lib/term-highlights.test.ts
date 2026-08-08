import { describe, expect, it } from "vitest";
import { buildHighlightedTextParts, type HighlightTerm } from "./term-highlights";

const ai: HighlightTerm = { id: "ai", term: "AI" };

function highlightedTexts(text: string, terms: HighlightTerm[]): string[] {
  return buildHighlightedTextParts(text, terms)
    .filter((part) => part.highlighted)
    .map((part) => part.text);
}

describe("buildHighlightedTextParts", () => {
  it("ASCII 단어 내부의 부분 문자열은 제외하고 독립 용어와 한국어 조사는 허용한다", () => {
    expect(highlightedTexts("daily 모델과 AI는 다릅니다", [ai])).toEqual(["AI"]);
    expect(highlightedTexts("RAG를 쓰지만 bragger는 다릅니다", [{ id: "rag", term: "RAG" }])).toEqual(["RAG"]);
  });

  it("NFKC 전각 표기를 원문 범위 그대로 강조한다", () => {
    expect(highlightedTexts("ＡＩ는 인공지능입니다", [ai])).toEqual(["ＡＩ"]);
  });

  it("정규화 과정에서 합쳐진 공백을 원문의 전체 범위로 되돌린다", () => {
    expect(
      highlightedTexts("Large   Language\tModel을 설명합니다", [
        { id: "llm", term: "Large Language Model" }
      ])
    ).toEqual(["Large   Language\tModel"]);
  });

  it("같은 위치의 겹치는 용어는 가장 긴 표기를 선택하고 뒤의 독립 용어도 찾는다", () => {
    expect(
      highlightedTexts("생성형 AI와 AI를 비교합니다", [
        ai,
        { id: "generative-ai", term: "생성형 AI" }
      ])
    ).toEqual(["생성형 AI", "AI"]);
  });

  it("한 호환문자 안에서 여러 용어가 매칭되어도 원문 glyph를 한 번만 강조한다", () => {
    const text = "㌖";
    const parts = buildHighlightedTextParts(text, [
      { id: "kilo", term: "キロ" },
      { id: "meter", term: "メートル" }
    ]);

    expect(parts).toEqual([{ text, highlighted: true, termId: "kilo" }]);
  });

  it("문맥 독립 소문자화로 Greek final sigma 위치를 서버 matcher와 동일하게 찾는다", () => {
    expect(highlightedTexts("ΟΣ", [{ id: "sigma", term: "Σ" }])).toEqual(["Σ"]);
  });

  it("모든 정규화·충돌 경우에 출력 조각을 합치면 원문과 정확히 같다", () => {
    const cases: Array<{ text: string; terms: HighlightTerm[] }> = [
      { text: "daily 모델과 AI는 다릅니다", terms: [ai] },
      { text: "ＡＩ는 인공지능입니다", terms: [ai] },
      { text: "Large   Language\tModel", terms: [{ id: "llm", term: "Large Language Model" }] },
      { text: "㌖", terms: [{ id: "kilo", term: "キロ" }, { id: "meter", term: "メートル" }] },
      { text: "ΟΣ", terms: [{ id: "sigma", term: "Σ" }] }
    ];

    for (const testCase of cases) {
      const reconstructed = buildHighlightedTextParts(testCase.text, testCase.terms)
        .map((part) => part.text)
        .join("");
      expect(reconstructed).toBe(testCase.text);
    }
  });

  it("일치가 없으면 원문을 하나의 일반 조각으로 유지한다", () => {
    expect(buildHighlightedTextParts("일반 문장", [ai])).toEqual([{ text: "일반 문장", highlighted: false }]);
  });
});

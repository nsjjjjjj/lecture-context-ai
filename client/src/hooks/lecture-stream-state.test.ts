import { describe, expect, it } from "vitest";
import type { GlossaryTerm } from "../types";
import {
  createInitialLectureStreamState,
  createLectureStartMessage,
  isCurrentLectureSession,
  lectureStreamReducer,
  shouldTransitionToResults
} from "./lecture-stream-state";

const terms: GlossaryTerm[] = [
  {
    id: "rag",
    term: "RAG",
    english: "Retrieval-Augmented Generation",
    easyExplanation: "외부 자료를 찾아 답변하는 방식",
    pageNumber: 3,
    occurrences: 2,
    source: "demo"
  }
];

describe("lecture stream protocol", () => {
  it("sends every analyzed PhraseSet hint in the start message", () => {
    const phraseSet = ["RAG", "Retrieval-Augmented Generation"];

    expect(createLectureStartMessage("live", terms, phraseSet)).toEqual({
      type: "start",
      mode: "live",
      terms,
      phraseSet
    });
  });
});

describe("lecture stream lifecycle", () => {
  it("retains final transcript data when the server ends the stream", () => {
    const initial = createInitialLectureStreamState("rag");
    const withFinal = lectureStreamReducer(initial, {
      type: "final",
      line: { id: "line-1", text: "RAG를 설명합니다.", termIds: ["rag"], relatedPage: 3 },
      activeTermId: "rag"
    });

    const ended = lectureStreamReducer(withFinal, { type: "ended", message: "데모 강연이 끝났습니다." });

    expect(ended.status).toBe("ended");
    expect(ended.interim).toBe("");
    expect(ended.lines).toEqual(withFinal.lines);
  });

  it("transitions to results only when an active lecture has ended", () => {
    expect(shouldTransitionToResults("live", "ended")).toBe(true);
    expect(shouldTransitionToResults("results", "ended")).toBe(false);
    expect(shouldTransitionToResults("live", "ready")).toBe(false);
  });

  it("rejects asynchronous completion from an older session", () => {
    expect(isCurrentLectureSession(4, 3)).toBe(false);
    expect(isCurrentLectureSession(4, 4)).toBe(true);
  });
});

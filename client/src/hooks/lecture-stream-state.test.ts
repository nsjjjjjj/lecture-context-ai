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

  it("live stop 중 delayed final을 보존하고 server ended에서만 종료한다", () => {
    const ready = lectureStreamReducer(createInitialLectureStreamState("rag"), { type: "ready" });
    const stopping = lectureStreamReducer(ready, { type: "stopping" });
    const withFinal = lectureStreamReducer(stopping, {
      type: "final",
      line: { id: "tail", text: "마지막 확정 자막", termIds: [], relatedPage: 3 }
    });

    expect(stopping.status).toBe("stopping");
    expect(withFinal.status).toBe("stopping");

    const ended = lectureStreamReducer(withFinal, { type: "ended", message: "강연을 종료했습니다." });
    expect(ended.status).toBe("ended");
    expect(ended.lines).toEqual([expect.objectContaining({ id: "tail", text: "마지막 확정 자막" })]);
  });

  it("transitions to results only when an active lecture has ended", () => {
    expect(shouldTransitionToResults("live", "ready", "ended")).toBe(true);
    expect(shouldTransitionToResults("results", "ready", "ended")).toBe(false);
    expect(shouldTransitionToResults("live", "connecting", "ready")).toBe(false);
  });

  it("does not treat a previous session's ended status as a new ending during restart", () => {
    const ended = lectureStreamReducer(createInitialLectureStreamState("rag"), { type: "ended" });

    expect(shouldTransitionToResults("live", ended.status, ended.status)).toBe(false);

    const restarting = lectureStreamReducer(ended, { type: "starting", mode: "demo", activeTermId: "rag" });
    expect(restarting.status).toBe("connecting");
    expect(restarting.lines).toEqual([]);
    expect(shouldTransitionToResults("live", ended.status, restarting.status)).toBe(false);
  });

  it("rejects asynchronous completion from an older session", () => {
    expect(isCurrentLectureSession(4, 3)).toBe(false);
    expect(isCurrentLectureSession(4, 4)).toBe(true);
  });
});

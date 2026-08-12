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
    spokenAliases: ["래그", "레그", "알에이지"],
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
  it("provider와 capture가 모두 준비되기 전에는 connecting 상태를 유지한다", () => {
    const starting = lectureStreamReducer(createInitialLectureStreamState(), { type: "starting", mode: "live" });
    const providerOnly = lectureStreamReducer(starting, {
      type: "connection-progress",
      message: "마이크 입력을 확인하고 있습니다."
    });

    expect(providerOnly.status).toBe("connecting");
    expect(providerOnly.statusMessage).toBe("마이크 입력을 확인하고 있습니다.");

    const ready = lectureStreamReducer(providerOnly, { type: "ready", message: "마이크와 Google STT가 준비되었습니다." });
    expect(ready.status).toBe("ready");
  });

  it("retains final transcript data when the server ends the stream", () => {
    const initial = createInitialLectureStreamState();
    const withFinal = lectureStreamReducer(initial, {
      type: "final",
      line: { id: "line-1", text: "RAG를 설명합니다.", rawText: "RAG를 설명합니다.", termIds: ["rag"], relatedPage: 3, corrections: [] },
      occurrenceTermIds: ["rag"]
    });

    const ended = lectureStreamReducer(withFinal, { type: "ended", message: "데모 강연이 끝났습니다." });

    expect(ended.status).toBe("ended");
    expect(ended.interim).toBe("");
    expect(ended.lines).toEqual(withFinal.lines);
    expect(ended.termOccurrences).toEqual(withFinal.termOccurrences);
  });

  it("live stop 중 delayed final을 보존하고 server ended에서만 종료한다", () => {
    const ready = lectureStreamReducer(createInitialLectureStreamState(), { type: "ready" });
    const stopping = lectureStreamReducer(ready, { type: "stopping" });
    const withFinal = lectureStreamReducer(stopping, {
      type: "final",
      line: { id: "tail", text: "마지막 RAG 확정 자막", rawText: "마지막 RAG 확정 자막", termIds: ["rag"], relatedPage: 3, corrections: [] },
      occurrenceTermIds: ["rag"]
    });

    expect(stopping.status).toBe("stopping");
    expect(withFinal.status).toBe("stopping");
    expect(withFinal.termOccurrences).toEqual([
      { id: "tail:term:0", termId: "rag", transcriptLineId: "tail" }
    ]);

    const ended = lectureStreamReducer(withFinal, { type: "ended", message: "강연을 종료했습니다." });
    expect(ended.status).toBe("ended");
    expect(ended.lines).toEqual([expect.objectContaining({ id: "tail", text: "마지막 RAG 확정 자막" })]);
    expect(ended.termOccurrences).toEqual(withFinal.termOccurrences);
  });

  it("한 final의 마지막 언급을 맨 위에 두고 원래 occurrence index로 안정적인 id를 만든다", () => {
    const withFinal = lectureStreamReducer(createInitialLectureStreamState(), {
      type: "final",
      line: { id: "line-ordered", text: "LLM 다음 RAG", rawText: "LLM 다음 RAG", termIds: ["llm", "rag"], corrections: [] },
      occurrenceTermIds: ["llm", "rag"]
    });

    expect(withFinal.termOccurrences).toEqual([
      { id: "line-ordered:term:1", termId: "rag", transcriptLineId: "line-ordered" },
      { id: "line-ordered:term:0", termId: "llm", transcriptLineId: "line-ordered" }
    ]);
  });

  it("같은 용어가 다시 언급되면 기존 기록을 유지한 채 새 카드를 맨 위에 추가한다", () => {
    const first = lectureStreamReducer(createInitialLectureStreamState(), {
      type: "final",
      line: { id: "line-1", text: "첫 RAG", rawText: "첫 RAG", termIds: ["rag"], corrections: [] },
      occurrenceTermIds: ["rag"]
    });
    const second = lectureStreamReducer(first, {
      type: "final",
      line: { id: "line-2", text: "RAG와 다시 RAG", rawText: "RAG와 다시 RAG", termIds: ["rag"], corrections: [] },
      occurrenceTermIds: ["rag", "rag"]
    });

    expect(second.termOccurrences).toEqual([
      { id: "line-2:term:1", termId: "rag", transcriptLineId: "line-2" },
      { id: "line-2:term:0", termId: "rag", transcriptLineId: "line-2" },
      { id: "line-1:term:0", termId: "rag", transcriptLineId: "line-1" }
    ]);
  });

  it("interim은 용어 기록을 만들지 않고 새 강연 시작은 기존 기록을 초기화한다", () => {
    const withFinal = lectureStreamReducer(createInitialLectureStreamState(), {
      type: "final",
      line: { id: "line-1", text: "RAG", rawText: "RAG", termIds: ["rag"], corrections: [] },
      occurrenceTermIds: ["rag"]
    });
    const withInterim = lectureStreamReducer(withFinal, { type: "interim", text: "RAG를 다시" });

    expect(withInterim.termOccurrences).toEqual(withFinal.termOccurrences);

    const restarted = lectureStreamReducer(withInterim, { type: "starting", mode: "live" });
    expect(restarted.lines).toEqual([]);
    expect(restarted.termOccurrences).toEqual([]);
  });

  it("transitions to results only when an active lecture has ended", () => {
    expect(shouldTransitionToResults("live", "ready", "ended")).toBe(true);
    expect(shouldTransitionToResults("results", "ready", "ended")).toBe(false);
    expect(shouldTransitionToResults("live", "connecting", "ready")).toBe(false);
  });

  it("does not treat a previous session's ended status as a new ending during restart", () => {
    const ended = lectureStreamReducer(createInitialLectureStreamState(), { type: "ended" });

    expect(shouldTransitionToResults("live", ended.status, ended.status)).toBe(false);

    const restarting = lectureStreamReducer(ended, { type: "starting", mode: "demo" });
    expect(restarting.status).toBe("connecting");
    expect(restarting.lines).toEqual([]);
    expect(restarting.termOccurrences).toEqual([]);
    expect(shouldTransitionToResults("live", ended.status, restarting.status)).toBe(false);
  });

  it("rejects asynchronous completion from an older session", () => {
    expect(isCurrentLectureSession(4, 3)).toBe(false);
    expect(isCurrentLectureSession(4, 4)).toBe(true);
  });
});

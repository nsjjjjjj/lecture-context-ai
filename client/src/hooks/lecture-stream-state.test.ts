import { describe, expect, it } from "vitest";
import type { GlossaryTerm } from "../types";
import { composeContextualCaptionLines } from "../features/captions/live-caption-model";
import {
  appendContextualCaptionTail,
  createInitialLectureStreamState,
  createLectureStartMessage,
  isCurrentLectureSession,
  lectureStreamReducer,
  MAX_FINALIZED_SEGMENT_IDS,
  shouldTransitionToResults
} from "./lecture-stream-state";
import {
  materializeTranscriptLines,
  TRANSCRIPT_CHUNK_SIZE
} from "./transcript-store";

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

    const ready = lectureStreamReducer(providerOnly, { type: "ready", message: "마이크와 음성인식이 준비되었습니다." });
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
    expect(materializeTranscriptLines(ended.transcript)).toEqual(materializeTranscriptLines(withFinal.transcript));
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
    expect(materializeTranscriptLines(ended.transcript)).toEqual([
      expect.objectContaining({ id: "tail", text: "마지막 RAG 확정 자막" })
    ]);
    expect(ended.termOccurrences).toEqual(withFinal.termOccurrences);
  });

  it("치명적 오류에서는 확정되지 않은 partial을 즉시 지운다", () => {
    const partial = lectureStreamReducer(createInitialLectureStreamState(), {
      type: "partial",
      segmentId: "pending",
      revision: 1,
      text: "확정 전 문장"
    });
    const failed = lectureStreamReducer(partial, {
      type: "error",
      message: "전송 오류"
    });

    expect(failed.status).toBe("error");
    expect(failed.interim).toBe("");
    expect(failed.partialSegments).toEqual([]);
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

  it("같은 용어가 다시 언급되면 가장 최근의 고유 카드 하나만 유지한다", () => {
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
      { id: "line-2:term:1", termId: "rag", transcriptLineId: "line-2" }
    ]);
  });

  it("새 final에서 언급되지 않은 용어 카드는 유지하고 언급된 용어만 최신 위치로 옮긴다", () => {
    const first = lectureStreamReducer(createInitialLectureStreamState(), {
      type: "final",
      line: { id: "line-1", text: "RAG와 LLM", rawText: "RAG와 LLM", termIds: ["rag", "llm"], corrections: [] },
      occurrenceTermIds: ["rag", "llm"]
    });
    const second = lectureStreamReducer(first, {
      type: "final",
      line: { id: "line-2", text: "RAG 재언급", rawText: "RAG 재언급", termIds: ["rag"], corrections: [] },
      occurrenceTermIds: ["rag"]
    });

    expect(second.termOccurrences).toEqual([
      { id: "line-2:term:0", termId: "rag", transcriptLineId: "line-2" },
      { id: "line-1:term:1", termId: "llm", transcriptLineId: "line-1" }
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
    expect(restarted.transcript.lineCount).toBe(0);
    expect(restarted.captionTail).toEqual([]);
    expect(restarted.termOccurrences).toEqual([]);
  });

  it("segment별 최신 partial만 합치고 역순 revision은 무시한다", () => {
    const b1 = lectureStreamReducer(createInitialLectureStreamState(), {
      type: "partial",
      segmentId: "segment-b",
      revision: 1,
      text: "둘째 구간",
      startTimeMs: 1_000
    });
    const a1 = lectureStreamReducer(b1, {
      type: "partial",
      segmentId: "segment-a",
      revision: 1,
      text: "첫 구간",
      startTimeMs: 0
    });
    const a2 = lectureStreamReducer(a1, {
      type: "partial",
      segmentId: "segment-a",
      revision: 2,
      text: "첫 구간 수정",
      startTimeMs: 0
    });
    const stale = lectureStreamReducer(a2, {
      type: "partial",
      segmentId: "segment-a",
      revision: 1,
      text: "늦게 도착한 옛 문장"
    });

    expect(a2.interim).toBe("첫 구간 수정 둘째 구간");
    expect(stale).toBe(a2);
  });

  it("final은 같은 segment partial만 교체하고 중복 final과 뒤늦은 partial을 무시한다", () => {
    const partial = lectureStreamReducer(createInitialLectureStreamState(), {
      type: "partial",
      segmentId: "segment-a",
      revision: 1,
      text: "레그를 설명"
    });
    const withOtherPartial = lectureStreamReducer(partial, {
      type: "partial",
      segmentId: "segment-b",
      revision: 1,
      text: "다음 발화"
    });
    const finalAction = {
      type: "final" as const,
      segmentId: "segment-a",
      revision: 2,
      line: {
        id: "segment-a",
        text: "RAG를 설명합니다.",
        rawText: "레그를 설명합니다.",
        termIds: ["rag"],
        corrections: []
      },
      occurrenceTermIds: ["rag"]
    };
    const staleFinal = lectureStreamReducer(withOtherPartial, { ...finalAction, revision: 1 });
    const finalized = lectureStreamReducer(withOtherPartial, finalAction);
    const duplicate = lectureStreamReducer(finalized, finalAction);
    const latePartial = lectureStreamReducer(duplicate, {
      type: "partial",
      segmentId: "segment-a",
      revision: 3,
      text: "다시 나타나면 안 됨"
    });

    expect(staleFinal).toBe(withOtherPartial);
    expect(finalized.interim).toBe("다음 발화");
    expect(finalized.transcript.lineCount).toBe(1);
    expect(finalized.termOccurrences).toHaveLength(1);
    expect(duplicate).toBe(finalized);
    expect(latePartial).toBe(finalized);
  });

  it("오래 실행해도 finalized segment tombstone은 최근 항목까지만 유지한다", () => {
    let state = createInitialLectureStreamState();
    for (let index = 0; index <= MAX_FINALIZED_SEGMENT_IDS; index += 1) {
      state = lectureStreamReducer(state, {
        type: "final",
        segmentId: `segment-${index}`,
        revision: 1,
        line: {
          id: `segment-${index}`,
          text: `확정 ${index}`,
          rawText: `확정 ${index}`,
          termIds: [],
          corrections: []
        },
        occurrenceTermIds: []
      });
    }

    expect(state.finalizedSegmentIds).toHaveLength(MAX_FINALIZED_SEGMENT_IDS);
    expect(state.finalizedSegmentIds[0]).toBe("segment-1");
    expect(state.finalizedSegmentIds.at(-1)).toBe(`segment-${MAX_FINALIZED_SEGMENT_IDS}`);
  });

  it("증분 caption tail이 전체 문맥 조합 결과의 마지막 세 줄과 같다", () => {
    const fragments = [
      { id: "1", text: "오늘은", rawText: "오늘은", termIds: [], corrections: [] },
      { id: "2", text: "RAG를 설명합니다.", rawText: "레그를 설명합니다.", termIds: ["rag"], corrections: [] },
      { id: "3", text: "다음 문장입니다.", rawText: "다음 문장입니다.", termIds: [], corrections: [] },
      { id: "4", text: "이어지는", rawText: "이어지는", termIds: [], corrections: [] },
      { id: "5", text: "마지막 조각", rawText: "마지막 조각", termIds: [], corrections: [] }
    ];

    const incrementalTail = fragments.reduce(appendContextualCaptionTail, []);
    const fullCompositionTail = composeContextualCaptionLines(fragments).slice(-3);

    expect(incrementalTail).toEqual(fullCompositionTail);
  });

  it("10,000개 final을 bounded chunk 복사와 bounded caption tail로 누적한다", () => {
    const finalCount = 10_000;
    let state = createInitialLectureStreamState();

    for (let index = 0; index < finalCount; index += 1) {
      const termId = `term-${index % 50}`;
      state = lectureStreamReducer(state, {
        type: "final",
        line: {
          id: `line-${index}`,
          text: `확정 자막 ${index}.`,
          rawText: `확정 자막 ${index}.`,
          termIds: [termId],
          corrections: []
        },
        occurrenceTermIds: [termId]
      });
    }

    const materialized = materializeTranscriptLines(state.transcript);
    expect(state.transcript.appendOperations).toBe(finalCount);
    expect(state.transcript.completedChunks).toHaveLength(Math.floor(finalCount / TRANSCRIPT_CHUNK_SIZE));
    expect(state.transcript.activeChunk.length).toBe(finalCount % TRANSCRIPT_CHUNK_SIZE);
    expect(state.transcript.structuralReferenceCopies).toBeLessThan(finalCount * TRANSCRIPT_CHUNK_SIZE);
    expect(materialized).toHaveLength(finalCount);
    expect(materialized[0].id).toBe("line-0");
    expect(materialized.at(-1)?.id).toBe("line-9999");
    expect(state.captionTail.map((line) => line.id)).toEqual(["line-9997", "line-9998", "line-9999"]);
    expect(state.termOccurrences).toHaveLength(50);
    expect(state.termOccurrences[0]).toEqual({
      id: "line-9999:term:0",
      termId: "term-49",
      transcriptLineId: "line-9999"
    });
  });

  it("정상 종료와 전송·flush 실패를 서로 다른 typed outcome으로 보존한다", () => {
    const ended = lectureStreamReducer(createInitialLectureStreamState(), {
      type: "ended",
      message: "정상 종료"
    });
    const flushTimedOut = lectureStreamReducer(createInitialLectureStreamState(), {
      type: "error",
      message: "마지막 자막 시간 초과",
      outcome: {
        status: "flush-timeout",
        reason: "server-flush-timeout",
        message: "마지막 자막 시간 초과"
      }
    });
    const transportFailed = lectureStreamReducer(createInitialLectureStreamState(), {
      type: "error",
      message: "연결 종료",
      outcome: { status: "transport-error", reason: "socket", message: "연결 종료" }
    });

    expect(ended.sessionOutcome).toEqual({
      status: "completed",
      reason: "server-ended",
      message: "정상 종료"
    });
    expect(flushTimedOut.sessionOutcome?.status).toBe("flush-timeout");
    expect(transportFailed.sessionOutcome?.status).toBe("transport-error");
  });

  it("discard는 transcript, 용어 카드, partial, outcome을 즉시 초기 상태로 비운다", () => {
    const withPartial = lectureStreamReducer(createInitialLectureStreamState(), {
      type: "partial",
      segmentId: "segment-pending",
      revision: 1,
      text: "아직 확정되지 않은 자막"
    });
    const withFinal = lectureStreamReducer(withPartial, {
      type: "final",
      segmentId: "segment-final",
      revision: 1,
      line: {
        id: "segment-final",
        text: "RAG 확정 자막",
        rawText: "RAG 확정 자막",
        termIds: ["rag"],
        corrections: []
      },
      occurrenceTermIds: ["rag"]
    });
    const failed = lectureStreamReducer(withFinal, {
      type: "error",
      message: "연결 오류",
      outcome: { status: "transport-error", reason: "socket", message: "연결 오류" }
    });

    const discarded = lectureStreamReducer(failed, { type: "discard" });

    expect(discarded).toEqual(createInitialLectureStreamState());
    expect(discarded.transcript.lineCount).toBe(0);
    expect(discarded.captionTail).toEqual([]);
    expect(discarded.termOccurrences).toEqual([]);
    expect(discarded.sessionOutcome).toBeNull();
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
    expect(restarting.transcript.lineCount).toBe(0);
    expect(restarting.captionTail).toEqual([]);
    expect(restarting.termOccurrences).toEqual([]);
    expect(shouldTransitionToResults("live", ended.status, restarting.status)).toBe(false);
  });

  it("rejects asynchronous completion from an older session", () => {
    expect(isCurrentLectureSession(4, 3)).toBe(false);
    expect(isCurrentLectureSession(4, 4)).toBe(true);
  });
});

import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  App,
  Header,
  LIVE_CAPTION_SIZE_CLASS,
  LiveCaptionSlot,
  UPLOAD_CARD_GLOW_PROPS,
  appRouteHash,
  calculateHistoryRowScrollTop,
  parseAppHash,
  resolveLiveCaptionPresentation,
  resolveAppRoute,
  type AppRoute
} from "./App";
import { requireNonEmptyGlossary, shouldSyncGlossaryStorageEvent } from "./app-state";
import { createInitialLectureStreamState, lectureStreamReducer } from "./hooks/lecture-stream-state";
import type { AnalysisResult, TranscriptLine } from "./types";

const transcriptLine = (id: string, text: string): TranscriptLine => ({
  id,
  text,
  rawText: text,
  termIds: [],
  corrections: []
});

describe("upload screen interaction layers", () => {
  it("keeps the decorative glow out of pointer hit-testing", () => {
    expect(UPLOAD_CARD_GLOW_PROPS["aria-hidden"]).toBe(true);
    expect(UPLOAD_CARD_GLOW_PROPS.className.split(/\s+/)).toContain("pointer-events-none");
  });
});

describe("live caption presentation", () => {
  const firstFinal = transcriptLine("line-1", "첫 번째 확정 자막");
  const correctedFinal = transcriptLine("line-2", "RAG 정정 확정 자막");

  it("prioritizes raw interim text and moves only the previous final into history", () => {
    const firstInterim = resolveLiveCaptionPresentation([firstFinal], "알에이지 임시 자막");
    const continuedInterim = resolveLiveCaptionPresentation([firstFinal], "알에이지 임시 자막 이어짐");

    expect(firstInterim).toEqual({
      historyLines: [firstFinal],
      slot: { kind: "interim", text: "알에이지 임시 자막" }
    });
    expect(continuedInterim.historyLines).toEqual([firstFinal]);
    expect(continuedInterim.slot).toEqual({ kind: "interim", text: "알에이지 임시 자막 이어짐" });
  });

  it("falls back to the corrected final in the same slot and otherwise uses the placeholder", () => {
    expect(resolveLiveCaptionPresentation([firstFinal, correctedFinal], "")).toEqual({
      historyLines: [firstFinal],
      slot: { kind: "final", line: correctedFinal }
    });
    expect(resolveLiveCaptionPresentation([], "")).toEqual({
      historyLines: [],
      slot: { kind: "placeholder", text: "마이크에 대고 강연을 시작해 주세요." }
    });
  });

  it.each(["normal", "large", "xlarge"] as const)(
    "uses the same %s size class path for interim and final",
    (fontScale) => {
      const sizeClass = LIVE_CAPTION_SIZE_CLASS[fontScale];
      const interimHtml = renderToStaticMarkup(createElement(LiveCaptionSlot, {
        slot: { kind: "interim", text: "알에이지" },
        terms: [],
        sizeClass
      }));
      const finalHtml = renderToStaticMarkup(createElement(LiveCaptionSlot, {
        slot: { kind: "final", line: correctedFinal },
        terms: [],
        sizeClass
      }));

      expect(interimHtml).toContain(sizeClass);
      expect(finalHtml).toContain(sizeClass);
    }
  );

  it("keeps the three responsive accessibility sizes explicit", () => {
    expect(LIVE_CAPTION_SIZE_CLASS).toEqual({
      normal: "caption-normal text-xl sm:text-2xl",
      large: "caption-large text-2xl sm:text-[1.9rem]",
      xlarge: "caption-xlarge text-[1.8rem] sm:text-[2.3rem]"
    });
  });

  it("moves three reducer finals into history one at a time across interim transitions", () => {
    const correction = {
      originalText: "레그",
      correctedText: "RAG",
      termId: "rag",
      displayStart: 0,
      displayEnd: 3,
      reason: "spokenAlias" as const
    };
    const correctedFirstFinal: TranscriptLine = {
      id: "line-1",
      text: "RAG를 설명합니다.",
      rawText: "레그를 설명합니다.",
      termIds: ["rag"],
      corrections: [correction]
    };
    const secondFinal = transcriptLine("line-2", "두 번째 확정 자막");
    const thirdFinal = transcriptLine("line-3", "세 번째 확정 자막");
    let state = createInitialLectureStreamState();

    expect(resolveLiveCaptionPresentation(state.lines, state.interim).slot.kind).toBe("placeholder");

    state = lectureStreamReducer(state, { type: "interim", text: "레그를 설명합니다." });
    expect(resolveLiveCaptionPresentation(state.lines, state.interim)).toMatchObject({
      historyLines: [],
      slot: { kind: "interim", text: "레그를 설명합니다." }
    });

    state = lectureStreamReducer(state, {
      type: "final",
      line: correctedFirstFinal,
      occurrenceTermIds: ["rag"]
    });
    expect(state.interim).toBe("");
    expect(state.lines[0]).toMatchObject({
      rawText: "레그를 설명합니다.",
      corrections: [correction]
    });
    expect(resolveLiveCaptionPresentation(state.lines, state.interim)).toEqual({
      historyLines: [],
      slot: { kind: "final", line: correctedFirstFinal }
    });

    state = lectureStreamReducer(state, { type: "interim", text: "두 번째 임시 자막" });
    expect(resolveLiveCaptionPresentation(state.lines, state.interim).historyLines).toEqual([correctedFirstFinal]);
    state = lectureStreamReducer(state, { type: "final", line: secondFinal, occurrenceTermIds: [] });
    expect(resolveLiveCaptionPresentation(state.lines, state.interim)).toEqual({
      historyLines: [correctedFirstFinal],
      slot: { kind: "final", line: secondFinal }
    });

    state = lectureStreamReducer(state, { type: "interim", text: "세 번째 임시 자막" });
    expect(resolveLiveCaptionPresentation(state.lines, state.interim).historyLines).toEqual([
      correctedFirstFinal,
      secondFinal
    ]);
    state = lectureStreamReducer(state, { type: "final", line: thirdFinal, occurrenceTermIds: [] });
    expect(resolveLiveCaptionPresentation(state.lines, state.interim)).toEqual({
      historyLines: [correctedFirstFinal, secondFinal],
      slot: { kind: "final", line: thirdFinal }
    });

    state = lectureStreamReducer(state, { type: "interim", text: "다음 임시 자막" });
    expect(resolveLiveCaptionPresentation(state.lines, state.interim).historyLines).toEqual([
      correctedFirstFinal,
      secondFinal,
      thirdFinal
    ]);
  });
});

describe("live caption history scrolling", () => {
  it("derives the internal scroll target from the newest row bottom", () => {
    expect(calculateHistoryRowScrollTop(120, 500, 560)).toBe(180);
    expect(calculateHistoryRowScrollTop(120, 500, 480)).toBe(120);
    expect(calculateHistoryRowScrollTop(0, 500, 900)).toBe(400);
  });
});

describe("app hash routes", () => {
  it.each([
    ["#/lecture", { page: "lecture" }],
    ["#/experiment/setup", { page: "experiment", panel: "setup" }],
    ["#/experiment/record", { page: "experiment", panel: "record" }],
    ["#/experiment/run", { page: "experiment", panel: "run" }],
    ["#/experiment/results", { page: "experiment", panel: "results" }]
  ] as const)("parses %s", (hash, expected) => {
    expect(parseAppHash(hash)).toEqual(expected);
    expect(appRouteHash(expected as AppRoute)).toBe(hash);
  });

  it("falls back to lecture for invalid hashes and production experiment URLs", () => {
    expect(parseAppHash("#/unknown")).toEqual({ page: "lecture" });
    expect(parseAppHash("")).toEqual({ page: "lecture" });
    expect(resolveAppRoute("#/experiment/run", false)).toEqual({ page: "lecture" });
  });
});

describe("primary application navigation", () => {
  const renderHeader = (route: AppRoute, experimentNavigationBlocked = false, development = true) => renderToStaticMarkup(createElement(Header, {
    stage: experimentNavigationBlocked ? "analyzing" : "upload",
    route,
    development,
    experimentNavigationBlocked,
    onHome: () => undefined,
    onNavigate: () => undefined
  }));

  it("marks only the active primary destination as the current page", () => {
    const lectureHtml = renderHeader({ page: "lecture" });
    expect(lectureHtml).toContain('<nav aria-label="주요 메뉴"');
    expect(lectureHtml).toMatch(/href="#\/lecture" aria-current="page"/);
    expect(lectureHtml).not.toMatch(/href="#\/experiment\/record" aria-current="page"/);

    const experimentHtml = renderHeader({ page: "experiment", panel: "run" });
    expect(experimentHtml).toMatch(/href="#\/experiment\/run" aria-current="page"/);
    expect(experimentHtml).not.toMatch(/href="#\/lecture" aria-current="page"/);
  });

  it("hides the experiment destination while lecture work cannot be abandoned", () => {
    const html = renderHeader({ page: "lecture" }, true);
    expect(html).toContain("강연");
    expect(html).not.toContain("STT 실험실");
  });

  it("does not expose the experiment destination outside development", () => {
    expect(renderHeader({ page: "lecture" }, false, false)).not.toContain("STT 실험실");
  });
});

describe("lecture route isolation", () => {
  const TestableApp = App as FunctionComponent<{ initialHash?: string }>;

  it("keeps the first lecture screen limited to PDF, demo, and stored glossary product flow", () => {
    const html = renderToStaticMarkup(createElement(TestableApp, { initialHash: "#/lecture" }));

    expect(html).toContain("PDF를 여기에 놓아주세요");
    expect(html).toContain("샘플 강연 바로 체험하기");
    expect(html).toContain("이 브라우저의 용어집");
    expect(html).not.toContain('data-testid="audio-fixture-recorder"');
    expect(html).not.toContain("A/B/C STT 비교 실행");
    expect(html).not.toContain("저장된 STT 비교 결과");
  });

  it("renders the requested experiment panel on refresh and lecture for an invalid hash", () => {
    const experimentHtml = renderToStaticMarkup(createElement(TestableApp, { initialHash: "#/experiment/results" }));
    expect(experimentHtml).toContain('data-testid="experiment-task-results"');
    expect(experimentHtml).not.toContain("PDF를 여기에 놓아주세요");

    const fallbackHtml = renderToStaticMarkup(createElement(TestableApp, { initialHash: "#/invalid" }));
    expect(fallbackHtml).toContain("PDF를 여기에 놓아주세요");
    expect(fallbackHtml).not.toContain('data-testid="experiment-task-');
  });
});

describe("app glossary state guards", () => {
  it("rejects an empty analyzed glossary before Ready/demo flow", () => {
    const emptyAnalysis: AnalysisResult = {
      title: "빈 분석",
      pages: [{ pageNumber: 1, text: "일반 문장" }],
      terms: [],
      phraseSet: [],
      mode: "heuristic"
    };

    expect(() => requireNonEmptyGlossary(emptyAnalysis)).toThrow("전문용어를 찾지 못했습니다");
  });

  it("refreshes only for this glossary store or a browser-wide storage clear", () => {
    expect(shouldSyncGlossaryStorageEvent("lecture-context-ai.glossaries")).toBe(true);
    expect(shouldSyncGlossaryStorageEvent(null)).toBe(true);
    expect(shouldSyncGlossaryStorageEvent("another-app.key")).toBe(false);
  });
});

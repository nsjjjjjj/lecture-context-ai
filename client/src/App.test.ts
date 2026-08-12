import { readFileSync } from "node:fs";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  App,
  Header,
  LIVE_CAPTION_SIZE_CLASS,
  LiveCaptionRows,
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
  const secondFinal = transcriptLine("line-2", "두 번째 확정 자막");
  const thirdFinal = transcriptLine("line-3", "세 번째 확정 자막");
  const placeholder = { kind: "placeholder", text: "마이크에 대고 강연을 시작해 주세요." } as const;

  it.each([
    {
      name: "none",
      lines: [],
      interim: "",
      expected: { historyLines: [], upper: null, lower: placeholder }
    },
    {
      name: "interim1",
      lines: [],
      interim: "첫 임시 자막",
      expected: { historyLines: [], upper: null, lower: { kind: "interim", text: "첫 임시 자막" } }
    },
    {
      name: "final1",
      lines: [firstFinal],
      interim: "",
      expected: { historyLines: [], upper: null, lower: { kind: "final", line: firstFinal } }
    },
    {
      name: "interim2a",
      lines: [firstFinal],
      interim: "두 번째 임시 자막",
      expected: {
        historyLines: [],
        upper: { kind: "final", line: firstFinal },
        lower: { kind: "interim", text: "두 번째 임시 자막" }
      }
    },
    {
      name: "interim2b",
      lines: [firstFinal],
      interim: "두 번째 임시 자막 이어짐",
      expected: {
        historyLines: [],
        upper: { kind: "final", line: firstFinal },
        lower: { kind: "interim", text: "두 번째 임시 자막 이어짐" }
      }
    },
    {
      name: "final2",
      lines: [firstFinal, secondFinal],
      interim: "",
      expected: {
        historyLines: [],
        upper: { kind: "final", line: firstFinal },
        lower: { kind: "final", line: secondFinal }
      }
    },
    {
      name: "interim3",
      lines: [firstFinal, secondFinal],
      interim: "세 번째 임시 자막",
      expected: {
        historyLines: [firstFinal],
        upper: { kind: "final", line: secondFinal },
        lower: { kind: "interim", text: "세 번째 임시 자막" }
      }
    }
  ])("projects $name into the fixed upper/lower window", ({ lines, interim, expected }) => {
    expect(resolveLiveCaptionPresentation(lines, interim)).toEqual(expected);
  });

  it("treats blank interim text as absent and rotates finals received without a prior interim", () => {
    expect(resolveLiveCaptionPresentation([firstFinal, secondFinal], "  \n ")).toEqual({
      historyLines: [],
      upper: { kind: "final", line: firstFinal },
      lower: { kind: "final", line: secondFinal }
    });
    expect(resolveLiveCaptionPresentation([firstFinal, secondFinal, thirdFinal], "")).toEqual({
      historyLines: [firstFinal],
      upper: { kind: "final", line: secondFinal },
      lower: { kind: "final", line: thirdFinal }
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
        slot: { kind: "final", line: firstFinal },
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

  it("updates only the lower projection for consecutive reducer interim events, then replaces it immediately with the final", () => {
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
    let state = createInitialLectureStreamState();

    expect(resolveLiveCaptionPresentation(state.lines, state.interim).lower.kind).toBe("placeholder");

    state = lectureStreamReducer(state, { type: "interim", text: "레그를 설명합니다." });
    const firstInterim = resolveLiveCaptionPresentation(state.lines, state.interim);
    expect(firstInterim).toEqual({
      historyLines: [], upper: null, lower: { kind: "interim", text: "레그를 설명합니다." }
    });

    state = lectureStreamReducer(state, { type: "interim", text: "레그를 자세히 설명합니다." });
    const continuedInterim = resolveLiveCaptionPresentation(state.lines, state.interim);
    expect(continuedInterim.upper).toBe(firstInterim.upper);
    expect(continuedInterim.historyLines).toEqual(firstInterim.historyLines);
    expect(continuedInterim.lower).toEqual({ kind: "interim", text: "레그를 자세히 설명합니다." });

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
      upper: null,
      lower: { kind: "final", line: correctedFirstFinal }
    });

    state = lectureStreamReducer(state, { type: "interim", text: "두 번째 임시 자막" });
    expect(resolveLiveCaptionPresentation(state.lines, state.interim)).toEqual({
      historyLines: [],
      upper: { kind: "final", line: correctedFirstFinal },
      lower: { kind: "interim", text: "두 번째 임시 자막" }
    });
    state = lectureStreamReducer(state, { type: "final", line: secondFinal, occurrenceTermIds: [] });
    expect(resolveLiveCaptionPresentation(state.lines, state.interim)).toEqual({
      historyLines: [],
      upper: { kind: "final", line: correctedFirstFinal },
      lower: { kind: "final", line: secondFinal }
    });

    state = lectureStreamReducer(state, { type: "interim", text: "세 번째 임시 자막" });
    expect(resolveLiveCaptionPresentation(state.lines, state.interim)).toEqual({
      historyLines: [correctedFirstFinal],
      upper: { kind: "final", line: secondFinal },
      lower: { kind: "interim", text: "세 번째 임시 자막" }
    });
  });

  it("rotates three reducer finals in order even when none is preceded by an interim", () => {
    let state = createInitialLectureStreamState();

    state = lectureStreamReducer(state, { type: "final", line: firstFinal, occurrenceTermIds: [] });
    expect(resolveLiveCaptionPresentation(state.lines, state.interim)).toEqual({
      historyLines: [],
      upper: null,
      lower: { kind: "final", line: firstFinal }
    });

    state = lectureStreamReducer(state, { type: "final", line: secondFinal, occurrenceTermIds: [] });
    expect(resolveLiveCaptionPresentation(state.lines, state.interim)).toEqual({
      historyLines: [],
      upper: { kind: "final", line: firstFinal },
      lower: { kind: "final", line: secondFinal }
    });

    state = lectureStreamReducer(state, { type: "final", line: thirdFinal, occurrenceTermIds: [] });
    expect(resolveLiveCaptionPresentation(state.lines, state.interim)).toEqual({
      historyLines: [firstFinal],
      upper: { kind: "final", line: secondFinal },
      lower: { kind: "final", line: thirdFinal }
    });
  });

  it("renders corrected final data through TransparentCaption in the lower row", () => {
    const correctedFinal: TranscriptLine = {
      id: "corrected-line",
      text: "RAG를 설명합니다.",
      rawText: "레그를 설명합니다.",
      termIds: ["rag"],
      corrections: [{
        originalText: "레그",
        correctedText: "RAG",
        termId: "rag",
        displayStart: 0,
        displayEnd: 3,
        reason: "spokenAlias"
      }]
    };
    const presentation = resolveLiveCaptionPresentation([correctedFinal], "");
    const html = renderToStaticMarkup(createElement(LiveCaptionRows, {
      presentation,
      terms: [],
      sizeClass: LIVE_CAPTION_SIZE_CLASS.normal
    }));

    expect(presentation.lower).toEqual({ kind: "final", line: correctedFinal });
    expect(html).toContain("정정 표기: RAG, 원래 음성 인식: 레그");
    expect(html).toContain(">RAG</mark>");
    expect(html).toContain(">(레그)</span>");
  });

  it.each([
    [[], ""],
    [[], "임시 자막"],
    [[firstFinal], ""],
    [[firstFinal], "다음 임시 자막"],
    [[firstFinal, secondFinal], ""]
  ] as const)("renders at most two semantic caption rows for lines=%j interim=%s", (lines, interim) => {
    const html = renderToStaticMarkup(createElement(LiveCaptionRows, {
      presentation: resolveLiveCaptionPresentation([...lines], interim),
      terms: [],
      sizeClass: LIVE_CAPTION_SIZE_CLASS.normal
    }));
    const semanticRows = html.match(/<p\b/g) ?? [];

    expect(semanticRows.length).toBeGreaterThan(0);
    expect(semanticRows.length).toBeLessThanOrEqual(2);
    expect(html).not.toContain("caption-live-enter");
    expect(html).not.toMatch(/line-clamp|truncate/);
  });

  it("announces only the stable lower row as one atomic live-region update", () => {
    const html = renderToStaticMarkup(createElement(LiveCaptionRows, {
      presentation: resolveLiveCaptionPresentation([firstFinal], "다음 임시 자막"),
      terms: [],
      sizeClass: LIVE_CAPTION_SIZE_CLASS.normal
    }));
    const outerTag = html.match(/^<div[^>]*>/)?.[0] ?? "";
    const upperTag = html.match(/<div class="caption-live-upper"[^>]*>/)?.[0] ?? "";
    const lowerTag = html.match(/<div class="caption-live-lower"[^>]*>/)?.[0] ?? "";

    expect(outerTag).toContain('data-testid="live-caption-rows"');
    expect(outerTag).not.toContain("aria-live");
    expect(outerTag).not.toContain("aria-atomic");
    expect(upperTag).toContain('data-testid="live-caption-upper"');
    expect(upperTag).not.toContain("aria-live");
    expect(upperTag).not.toContain("aria-atomic");
    expect(lowerTag).toContain('data-testid="live-caption-lower"');
    expect(lowerTag).toContain('aria-live="polite"');
    expect(lowerTag).toContain('aria-atomic="true"');
  });

  it("keeps the live row free of opacity and translate animations", () => {
    const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const liveLineRule = stylesheet.match(/\.caption-live-line\s*\{([^}]*)\}/)?.[1];

    expect(liveLineRule).toBeDefined();
    expect(liveLineRule).not.toMatch(/\b(?:animation(?:-[\w-]+)?|opacity|transform)\s*:/);
    expect(stylesheet).not.toContain(".caption-live-enter");
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

import { readFileSync } from "node:fs";
import { createElement, type FunctionComponent, type ReactElement } from "react";
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
  const fourthFinal = transcriptLine("line-4", "네 번째 확정 자막");
  const placeholder = { kind: "placeholder", text: "마이크에 대고 강연을 시작해 주세요." } as const;

  it.each([
    {
      name: "none",
      lines: [],
      interim: "",
      expected: { historyLines: [], rows: [placeholder] }
    },
    {
      name: "interim1",
      lines: [],
      interim: "첫 임시 자막",
      expected: {
        historyLines: [],
        rows: [{ kind: "interim", text: "첫 임시 자막" }]
      }
    },
    {
      name: "final1",
      lines: [firstFinal],
      interim: "",
      expected: { historyLines: [], rows: [{ kind: "final", line: firstFinal }] }
    },
    {
      name: "interim2a",
      lines: [firstFinal],
      interim: "두 번째 임시 자막",
      expected: {
        historyLines: [],
        rows: [
          { kind: "final", line: firstFinal },
          { kind: "interim", text: "두 번째 임시 자막" }
        ]
      }
    },
    {
      name: "interim2b",
      lines: [firstFinal],
      interim: "두 번째 임시 자막 이어짐",
      expected: {
        historyLines: [],
        rows: [
          { kind: "final", line: firstFinal },
          { kind: "interim", text: "두 번째 임시 자막 이어짐" }
        ]
      }
    },
    {
      name: "final2",
      lines: [firstFinal, secondFinal],
      interim: "",
      expected: {
        historyLines: [],
        rows: [
          { kind: "final", line: firstFinal },
          { kind: "final", line: secondFinal }
        ]
      }
    },
    {
      name: "interim3",
      lines: [firstFinal, secondFinal],
      interim: "세 번째 임시 자막",
      expected: {
        historyLines: [],
        rows: [
          { kind: "final", line: firstFinal },
          { kind: "final", line: secondFinal },
          { kind: "interim", text: "세 번째 임시 자막" }
        ]
      }
    },
    {
      name: "final3",
      lines: [firstFinal, secondFinal, thirdFinal],
      interim: "",
      expected: {
        historyLines: [],
        rows: [
          { kind: "final", line: firstFinal },
          { kind: "final", line: secondFinal },
          { kind: "final", line: thirdFinal }
        ]
      }
    },
    {
      name: "interim4",
      lines: [firstFinal, secondFinal, thirdFinal],
      interim: "네 번째 임시 자막",
      expected: {
        historyLines: [firstFinal],
        rows: [
          { kind: "final", line: secondFinal },
          { kind: "final", line: thirdFinal },
          { kind: "interim", text: "네 번째 임시 자막" }
        ]
      }
    }
  ])("projects $name into a bottom-aligned three-row window", ({ lines, interim, expected }) => {
    expect(resolveLiveCaptionPresentation(lines, interim)).toEqual(expected);
  });

  it("treats blank interim text as absent and rotates finals received without a prior interim", () => {
    expect(resolveLiveCaptionPresentation([firstFinal, secondFinal], "  \n ")).toEqual({
      historyLines: [],
      rows: [
        { kind: "final", line: firstFinal },
        { kind: "final", line: secondFinal }
      ]
    });
    expect(resolveLiveCaptionPresentation([firstFinal, secondFinal, thirdFinal, fourthFinal], "")).toEqual({
      historyLines: [firstFinal],
      rows: [
        { kind: "final", line: secondFinal },
        { kind: "final", line: thirdFinal },
        { kind: "final", line: fourthFinal }
      ]
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
      expect(interimHtml).toContain("caption-live-interim");
      expect(finalHtml).toContain(sizeClass);
      expect(finalHtml).not.toContain("caption-live-interim");
    }
  );

  it("keeps the three responsive accessibility sizes explicit", () => {
    expect(LIVE_CAPTION_SIZE_CLASS).toEqual({
      normal: "caption-normal text-xl sm:text-2xl",
      large: "caption-large text-2xl sm:text-[1.9rem]",
      xlarge: "caption-xlarge text-[1.8rem] sm:text-[2.3rem]"
    });
  });

  it("updates the current projection for every interim, immediately replaces it with final, and continues through utterance four", () => {
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

    expect(resolveLiveCaptionPresentation(state.lines, state.interim).rows.at(-1)?.kind).toBe("placeholder");

    state = lectureStreamReducer(state, { type: "interim", text: "레그를 설명합니다." });
    const firstInterim = resolveLiveCaptionPresentation(state.lines, state.interim);
    expect(firstInterim).toEqual({
      historyLines: [], rows: [{ kind: "interim", text: "레그를 설명합니다." }]
    });

    state = lectureStreamReducer(state, { type: "interim", text: "레그를 자세히 설명합니다." });
    const continuedInterim = resolveLiveCaptionPresentation(state.lines, state.interim);
    expect(continuedInterim.rows).toHaveLength(firstInterim.rows.length);
    expect(continuedInterim.historyLines).toEqual(firstInterim.historyLines);
    expect(continuedInterim.rows.at(-1)).toEqual({ kind: "interim", text: "레그를 자세히 설명합니다." });

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
      rows: [{ kind: "final", line: correctedFirstFinal }]
    });

    state = lectureStreamReducer(state, { type: "interim", text: "두 번째 임시 자막" });
    expect(resolveLiveCaptionPresentation(state.lines, state.interim)).toEqual({
      historyLines: [],
      rows: [
        { kind: "final", line: correctedFirstFinal },
        { kind: "interim", text: "두 번째 임시 자막" }
      ]
    });
    state = lectureStreamReducer(state, { type: "final", line: secondFinal, occurrenceTermIds: [] });
    expect(resolveLiveCaptionPresentation(state.lines, state.interim)).toEqual({
      historyLines: [],
      rows: [
        { kind: "final", line: correctedFirstFinal },
        { kind: "final", line: secondFinal }
      ]
    });

    state = lectureStreamReducer(state, { type: "interim", text: "세 번째 임시 자막" });
    expect(resolveLiveCaptionPresentation(state.lines, state.interim)).toEqual({
      historyLines: [],
      rows: [
        { kind: "final", line: correctedFirstFinal },
        { kind: "final", line: secondFinal },
        { kind: "interim", text: "세 번째 임시 자막" }
      ]
    });

    state = lectureStreamReducer(state, { type: "final", line: thirdFinal, occurrenceTermIds: [] });
    expect(resolveLiveCaptionPresentation(state.lines, state.interim)).toEqual({
      historyLines: [],
      rows: [
        { kind: "final", line: correctedFirstFinal },
        { kind: "final", line: secondFinal },
        { kind: "final", line: thirdFinal }
      ]
    });

    state = lectureStreamReducer(state, { type: "interim", text: "네 번째 임시 자막" });
    expect(resolveLiveCaptionPresentation(state.lines, state.interim)).toEqual({
      historyLines: [correctedFirstFinal],
      rows: [
        { kind: "final", line: secondFinal },
        { kind: "final", line: thirdFinal },
        { kind: "interim", text: "네 번째 임시 자막" }
      ]
    });

    state = lectureStreamReducer(state, { type: "final", line: fourthFinal, occurrenceTermIds: [] });
    expect(resolveLiveCaptionPresentation(state.lines, state.interim)).toEqual({
      historyLines: [correctedFirstFinal],
      rows: [
        { kind: "final", line: secondFinal },
        { kind: "final", line: thirdFinal },
        { kind: "final", line: fourthFinal }
      ]
    });
  });

  it("renders a synthetic provider-response emission chain through the reducer and current DOM row", () => {
    const renderState = (state: ReturnType<typeof createInitialLectureStreamState>) =>
      renderToStaticMarkup(createElement(LiveCaptionRows, {
        presentation: resolveLiveCaptionPresentation(state.lines, state.interim),
        terms: [],
        sizeClass: LIVE_CAPTION_SIZE_CLASS.normal
      }));
    let state = createInitialLectureStreamState();

    // Each interim is the single combined tail projected from one provider response.
    state = lectureStreamReducer(state, { type: "interim", text: "오늘 날씨" });
    const firstResponseHtml = renderState(state);
    expect(firstResponseHtml).toContain('data-caption-kind="interim"');
    expect(firstResponseHtml).toContain("오늘 날씨");
    expect(firstResponseHtml.match(/<p\b/g)).toHaveLength(1);

    state = lectureStreamReducer(state, { type: "interim", text: "오늘 날씨가 좋습니다" });
    const continuedResponseHtml = renderState(state);
    expect(continuedResponseHtml).toContain("오늘 날씨가 좋습니다");
    expect(continuedResponseHtml.match(/<p\b/g)).toHaveLength(1);

    const correctedFinal: TranscriptLine = {
      id: "provider-final-1",
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
    state = lectureStreamReducer(state, { type: "final", line: correctedFinal, occurrenceTermIds: ["rag"] });
    const finalResponseHtml = renderState(state);
    expect(finalResponseHtml).toContain('data-caption-kind="final"');
    expect(finalResponseHtml).toContain("RAG");
    expect(finalResponseHtml).toContain("(레그)");
    expect(finalResponseHtml).not.toContain("오늘 날씨가 좋습니다");

    state = lectureStreamReducer(state, { type: "interim", text: "다음 발화 전체 임시 꼬리" });
    const nextResponseHtml = renderState(state);
    expect(nextResponseHtml.match(/<p\b/g)).toHaveLength(2);
    expect(nextResponseHtml).toContain("RAG");
    expect(nextResponseHtml).toContain("다음 발화 전체 임시 꼬리");
  });

  it("rotates three reducer finals in order even when none is preceded by an interim", () => {
    let state = createInitialLectureStreamState();

    state = lectureStreamReducer(state, { type: "final", line: firstFinal, occurrenceTermIds: [] });
    expect(resolveLiveCaptionPresentation(state.lines, state.interim)).toEqual({
      historyLines: [],
      rows: [{ kind: "final", line: firstFinal }]
    });

    state = lectureStreamReducer(state, { type: "final", line: secondFinal, occurrenceTermIds: [] });
    expect(resolveLiveCaptionPresentation(state.lines, state.interim)).toEqual({
      historyLines: [],
      rows: [
        { kind: "final", line: firstFinal },
        { kind: "final", line: secondFinal }
      ]
    });

    state = lectureStreamReducer(state, { type: "final", line: thirdFinal, occurrenceTermIds: [] });
    expect(resolveLiveCaptionPresentation(state.lines, state.interim)).toEqual({
      historyLines: [],
      rows: [
        { kind: "final", line: firstFinal },
        { kind: "final", line: secondFinal },
        { kind: "final", line: thirdFinal }
      ]
    });

    state = lectureStreamReducer(state, { type: "final", line: fourthFinal, occurrenceTermIds: [] });
    expect(resolveLiveCaptionPresentation(state.lines, state.interim)).toEqual({
      historyLines: [firstFinal],
      rows: [
        { kind: "final", line: secondFinal },
        { kind: "final", line: thirdFinal },
        { kind: "final", line: fourthFinal }
      ]
    });
  });

  it("renders corrected final data through TransparentCaption in the current row", () => {
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

    expect(presentation.rows.at(-1)).toEqual({ kind: "final", line: correctedFinal });
    expect(html).toContain("정정 표기: RAG, 원래 음성 인식: 레그");
    expect(html).toContain(">RAG</mark>");
    expect(html).toContain(">(레그)</span>");
  });

  it.each([
    [[], ""],
    [[], "임시 자막"],
    [[firstFinal], ""],
    [[firstFinal], "다음 임시 자막"],
    [[firstFinal, secondFinal], ""],
    [[firstFinal, secondFinal], "세 번째 임시 자막"],
    [[firstFinal, secondFinal, thirdFinal, fourthFinal], ""]
  ] as const)("renders at most three semantic caption rows for lines=%j interim=%s", (lines, interim) => {
    const html = renderToStaticMarkup(createElement(LiveCaptionRows, {
      presentation: resolveLiveCaptionPresentation([...lines], interim),
      terms: [],
      sizeClass: LIVE_CAPTION_SIZE_CLASS.normal
    }));
    const semanticRows = html.match(/<p\b/g) ?? [];

    expect(semanticRows.length).toBeGreaterThan(0);
    expect(semanticRows.length).toBeLessThanOrEqual(3);
    expect(html).not.toContain("caption-live-enter");
    expect(html).not.toMatch(/line-clamp|truncate/);
  });

  it("announces only the current bottom row as one atomic live-region update", () => {
    const html = renderToStaticMarkup(createElement(LiveCaptionRows, {
      presentation: resolveLiveCaptionPresentation([firstFinal, secondFinal], "다음 임시 자막"),
      terms: [],
      sizeClass: LIVE_CAPTION_SIZE_CLASS.normal
    }));
    const outerTag = html.match(/^<div[^>]*>/)?.[0] ?? "";
    const rowTags = html.match(/<div class="caption-live-row[^"]*"[^>]*>/g) ?? [];
    const previousTags = rowTags.slice(0, -1);
    const currentTag = rowTags.at(-1) ?? "";

    expect(outerTag).toContain('data-testid="live-caption-rows"');
    expect(outerTag).not.toContain("aria-live");
    expect(outerTag).not.toContain("aria-atomic");
    expect(rowTags).toHaveLength(3);
    expect(previousTags.every((tag) => !tag.includes("aria-live") && !tag.includes("aria-atomic"))).toBe(true);
    expect(currentTag).toContain('data-testid="live-caption-current"');
    expect(currentTag).toContain('aria-live="polite"');
    expect(currentTag).toContain('aria-atomic="true"');
  });

  it("keeps one fixed-key current wrapper mounted across interim-to-final updates", () => {
    type Wrapper = ReactElement<{
      "data-testid": string;
      "data-caption-kind": string;
      "aria-live": string;
      "aria-atomic": string;
    }>;
    const currentWrapper = (presentation: ReturnType<typeof resolveLiveCaptionPresentation>) => {
      const tree = LiveCaptionRows({
        presentation,
        terms: [],
        sizeClass: LIVE_CAPTION_SIZE_CLASS.normal
      });
      return (tree.props as { children: [unknown, Wrapper] }).children[1];
    };

    const interimWrapper = currentWrapper(resolveLiveCaptionPresentation([firstFinal], "두 번째 임시 자막"));
    const finalWrapper = currentWrapper(resolveLiveCaptionPresentation([firstFinal, secondFinal], ""));

    expect(interimWrapper.key).toBe("live-caption-current");
    expect(finalWrapper.key).toBe(interimWrapper.key);
    expect(interimWrapper.props["data-testid"]).toBe("live-caption-current");
    expect(finalWrapper.props["data-testid"]).toBe("live-caption-current");
    expect(interimWrapper.props["data-caption-kind"]).toBe("interim");
    expect(finalWrapper.props["data-caption-kind"]).toBe("final");
    expect(finalWrapper.props).toMatchObject({ "aria-live": "polite", "aria-atomic": "true" });
  });

  it("keeps updates instant and reserves three bottom-aligned rows at the selected caption scale", () => {
    const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const liveLineRule = stylesheet.match(/\.caption-live-line\s*\{([^}]*)\}/)?.[1];
    const stackRule = stylesheet.match(/\.caption-live-stack\s*\{([^}]*)\}/)?.[1];
    const rowRule = stylesheet.match(/\.caption-live-row\s*\{([^}]*)\}/)?.[1];
    const html = renderToStaticMarkup(createElement(LiveCaptionRows, {
      presentation: resolveLiveCaptionPresentation([firstFinal, secondFinal], "다음 임시 자막"),
      terms: [],
      sizeClass: LIVE_CAPTION_SIZE_CLASS.large
    }));

    expect(liveLineRule).toBeDefined();
    expect(liveLineRule).toMatch(/min-height:\s*1\.32em/);
    expect(liveLineRule).not.toMatch(/\b(?:animation(?:-[\w-]+)?|opacity|transform)\s*:/);
    expect(stackRule).toMatch(/min-height:\s*calc\(3\.96em \+ 24px\)/);
    expect(stackRule).toMatch(/grid-auto-rows:\s*minmax\(1\.32em, auto\)/);
    expect(stackRule).toMatch(/align-content:\s*end/);
    expect(stackRule).toMatch(/row-gap:\s*12px/);
    expect(stackRule).not.toMatch(/grid-template-rows/);
    expect(rowRule).not.toMatch(/\b(?:animation(?:-[\w-]+)?|opacity|transform|will-change)\s*:/);
    expect(html.match(/^<div[^>]*>/)?.[0]).toContain(LIVE_CAPTION_SIZE_CLASS.large);
    expect(stylesheet).not.toContain("caption-live-promote");
    expect(stylesheet).not.toContain(".caption-live-enter");
    expect(stylesheet).not.toContain("min-height: calc(3.96em + 1.5rem)");
  });

  it("keeps interim darker without changing its selected font-size path", () => {
    const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const interimRule = stylesheet.match(/\.caption-live-interim\s*\{([^}]*)\}/)?.[1];
    const highContrastInterimRule = stylesheet.match(/\.contrast-more \.caption-live-interim\s*\{([^}]*)\}/)?.[1];

    expect(interimRule).toMatch(/color:\s*#94a3b8/);
    expect(highContrastInterimRule).toMatch(/color:\s*#e2e8f0/);
    expect(interimRule).not.toMatch(/font-size/);
    expect(highContrastInterimRule).not.toMatch(/font-size/);
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

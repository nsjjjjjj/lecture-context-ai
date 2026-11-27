import { readFileSync } from "node:fs";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AnalyzingScreen,
  App,
  Header,
  LiveCaptionRows,
  LiveCaptionSlot,
  PresentationUploadCard,
  ResultsScreen,
} from "./App";
import { presentationUploadFailureMessage } from "./features/upload/upload-card-model";
import {
  ANALYSIS_STEP_ORDER,
  analysisProgressPercent,
  completedAnalysisStepCount,
  createAnalysisStepState,
  runPdfAnalysisSteps
} from "./features/analysis/analysis-workflow";
import {
  LIVE_CAPTION_CURRENT_KEY,
  LIVE_CAPTION_MAX_COMPOSED_CHARACTERS,
  LIVE_CAPTION_PROMOTION_DURATION_MS,
  LIVE_CAPTION_SIZE_CLASS,
  calculateCaptionFlipDelta,
  calculateHistoryRowScrollTop,
  cancelCaptionAnimations,
  captionJoinSeparator,
  composeContextualCaptionLines,
  createLiveCaptionMotionSnapshot,
  endsCaptionSentence,
  mergeTranscriptLines,
  resolveCaptionDisplayState,
  resolveLiveCaptionPresentation,
  resolveLiveCaptionRowKey,
  resolveRetainedFinalPromotions,
  resolveStableInterimPrefixLength,
  runCaptionPromotionAnimations
} from "./features/captions/live-caption-model";
import { UPLOAD_CARD_GLOW_PROPS } from "./features/upload/upload-card-model";
import { appRouteHash, parseAppHash, resolveAppRoute, type AppRoute } from "./app-route";
import { requireNonEmptyGlossary, shouldSyncGlossaryStorageEvent } from "./app-state";
import { createInitialLectureStreamState, lectureStreamReducer } from "./hooks/lecture-stream-state";
import { materializeTranscriptLines } from "./hooks/transcript-store";
import { GLOSSARY_STORAGE_KEY, GLOSSARY_STORAGE_RECOVERY_KEY } from "./lib/glossary-storage";
import type { PresentationAsset } from "./lib/presentation";
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

  it("keeps the presentation PDF separate and exposes the analyzed PDF as an explicit shortcut", () => {
    const emptyHtml = renderToStaticMarkup(createElement(PresentationUploadCard, {
      presentation: null,
      busy: false,
      disabled: false,
      error: "",
      analysisFileAvailable: true,
      onSelect: () => undefined,
      onUseAnalysisFile: () => undefined,
      onClear: () => undefined
    }));
    expect(emptyHtml).toContain("발표 PDF 선택");
    expect(emptyHtml).toContain("분석한 PDF를 발표에 사용");
    expect(emptyHtml).toContain("발표 PDF가 없어도 자막 모드로 시작할 수 있습니다.");

    const presentation = {
      id: "presentation-1",
      name: "keynote.pdf",
      file: {} as File,
      objectUrl: "blob:presentation",
      pageCount: 12
    } satisfies PresentationAsset;
    const selectedHtml = renderToStaticMarkup(createElement(PresentationUploadCard, {
      presentation,
      busy: false,
      disabled: false,
      error: "",
      analysisFileAvailable: true,
      onSelect: () => undefined,
      onUseAnalysisFile: () => undefined,
      onClear: () => undefined
    }));
    expect(selectedHtml).toContain("keynote.pdf");
    expect(selectedHtml).toContain("12페이지 · 첫 페이지 미리보기 확인 가능");
    expect(selectedHtml).toContain("발표 PDF 첫 페이지 미리보기");
    expect(selectedHtml).toContain("제거");
    expect(selectedHtml).not.toContain("분석한 PDF를 발표에 사용");
  });

  it("names both the attempted and retained presentation when replacement validation fails", () => {
    const replacementMessage = presentationUploadFailureMessage(
      new Error("암호화된 PDF는 열 수 없습니다."),
      "새 발표.pdf",
      "현재 발표.pdf"
    );
    const firstSelectionMessage = presentationUploadFailureMessage(
      new Error("PDF 파일만 사용할 수 있습니다."),
      "메모.txt"
    );

    expect(replacementMessage).toContain("‘새 발표.pdf’ 교체 실패");
    expect(replacementMessage).toContain("기존 발표 PDF 유지: ‘현재 발표.pdf’");
    expect(replacementMessage).toContain("그대로 시작하거나 다른 PDF를 선택하세요");
    expect(firstSelectionMessage).toContain("‘메모.txt’ 선택 실패");
    expect(firstSelectionMessage).toContain("발표 PDF 없이 자막 모드로 계속하세요");
  });
});

describe("PDF analysis progress workflow", () => {
  it("derives the progress bar and rendered completion count from explicit step statuses", () => {
    const state = { extract: "complete", analyze: "active", store: "pending" } as const;

    expect(ANALYSIS_STEP_ORDER).toEqual(["extract", "analyze", "store"]);
    expect(completedAnalysisStepCount(state)).toBe(1);
    expect(analysisProgressPercent(state)).toBe(33);

    const html = renderToStaticMarkup(createElement(AnalyzingScreen, {
      fileName: "lecture.pdf",
      stepState: state
    }));
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuemax="3"');
    expect(html).toContain('aria-valuenow="1"');
    expect(html).toContain('aria-valuetext="3단계 중 1단계 완료"');
    expect(html).toContain('data-analysis-step="extract" data-analysis-step-status="complete"');
    expect(html).toContain('data-analysis-step="analyze" data-analysis-step-status="active"');
    expect(html).toContain('data-analysis-step="store" data-analysis-step-status="pending"');
    expect(html).toContain("브라우저 용어집 검증·저장");
    expect(html).toContain('role="status" aria-live="polite" aria-atomic="true"');
  });

  it("publishes 1 → 2 → 3 completed steps only after their real operation boundaries", async () => {
    const states: Array<ReturnType<typeof createAnalysisStepState>> = [];
    const events: string[] = [];

    const readyValue = await runPdfAnalysisSteps({
      extract: async () => {
        events.push("extract");
        return ["page"];
      },
      analyze: async (pages) => {
        events.push(`analyze:${pages.length}`);
        return { terms: ["용어"] };
      },
      store: (analysis) => {
        events.push(`store:${analysis.terms.length}`);
        return { readyValue: "ready", completed: true };
      },
      onStateChange: (state) => states.push(state),
      waitForPresentation: async () => {
        events.push("present");
      }
    });

    expect(readyValue).toBe("ready");
    expect(states).toEqual([
      { extract: "active", analyze: "pending", store: "pending" },
      { extract: "complete", analyze: "active", store: "pending" },
      { extract: "complete", analyze: "complete", store: "active" },
      { extract: "complete", analyze: "complete", store: "complete" }
    ]);
    expect(states.map(completedAnalysisStepCount)).toEqual([0, 1, 2, 3]);
    expect(events).toEqual([
      "extract",
      "present",
      "analyze:1",
      "present",
      "store:1",
      "present"
    ]);
  });

  it("does not resolve ready until every completed state has passed its presentation gate", async () => {
    const releases: Array<() => void> = [];
    const analyze = vi.fn(async () => "analysis");
    const store = vi.fn(() => ({ readyValue: "ready", completed: true }));
    let resolved = false;
    const workflow = runPdfAnalysisSteps({
      extract: async () => "pages",
      analyze,
      store,
      onStateChange: vi.fn(),
      waitForPresentation: () => new Promise<void>((resolve) => releases.push(resolve))
    });
    void workflow.then(() => {
      resolved = true;
    });

    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(analyze).not.toHaveBeenCalled();
    expect(resolved).toBe(false);

    releases.shift()?.();
    await vi.waitFor(() => {
      expect(analyze).toHaveBeenCalledOnce();
      expect(releases).toHaveLength(1);
    });
    expect(store).not.toHaveBeenCalled();
    expect(resolved).toBe(false);

    releases.shift()?.();
    await vi.waitFor(() => {
      expect(store).toHaveBeenCalledOnce();
      expect(releases).toHaveLength(1);
    });
    expect(resolved).toBe(false);

    releases.shift()?.();
    await expect(workflow).resolves.toBe("ready");
    expect(resolved).toBe(true);
  });

  it("keeps unfinished steps incomplete when analysis fails", async () => {
    const states: Array<ReturnType<typeof createAnalysisStepState>> = [];
    const store = vi.fn();
    const present = vi.fn(async () => undefined);

    await expect(runPdfAnalysisSteps({
      extract: async () => ["page"],
      analyze: async () => {
        throw new Error("analysis failed");
      },
      store,
      onStateChange: (state) => states.push(state),
      waitForPresentation: present
    })).rejects.toThrow("analysis failed");

    expect(states.at(-1)).toEqual({ extract: "complete", analyze: "failed", store: "pending" });
    expect(completedAnalysisStepCount(states.at(-1)!)).toBe(1);
    expect(store).not.toHaveBeenCalled();
    expect(present).toHaveBeenCalledTimes(2);

    const html = renderToStaticMarkup(createElement(AnalyzingScreen, {
      fileName: "lecture.pdf",
      stepState: states.at(-1)!
    }));
    expect(html).toContain('data-analysis-step="analyze" data-analysis-step-status="failed"');
    expect(html).toContain('data-analysis-step="store" data-analysis-step-status="pending"');
    expect(html).toContain('aria-valuenow="1"');
  });

  it("marks browser storage failure truthfully while preserving the valid analysis for ready", async () => {
    const states: Array<ReturnType<typeof createAnalysisStepState>> = [];
    const present = vi.fn(async () => undefined);

    const readyValue = await runPdfAnalysisSteps({
      extract: async () => ["page"],
      analyze: async () => ({ title: "valid analysis" }),
      store: (analysis) => ({ readyValue: analysis, completed: false }),
      onStateChange: (state) => states.push(state),
      waitForPresentation: present
    });

    expect(readyValue).toEqual({ title: "valid analysis" });
    expect(states.at(-1)).toEqual({ extract: "complete", analyze: "complete", store: "failed" });
    expect(completedAnalysisStepCount(states.at(-1)!)).toBe(2);
    expect(present).toHaveBeenCalledTimes(3);
  });

  it("stops at the current boundary when the user cancels analysis", async () => {
    const controller = new AbortController();
    const states: Array<ReturnType<typeof createAnalysisStepState>> = [];
    let finishExtract!: (pages: string[]) => void;
    const analyze = vi.fn(async () => "analysis");
    const store = vi.fn(() => ({ readyValue: "ready", completed: true }));
    const workflow = runPdfAnalysisSteps({
      extract: () => new Promise<string[]>((resolve) => {
        finishExtract = resolve;
      }),
      analyze,
      store,
      onStateChange: (state) => states.push(state),
      signal: controller.signal,
      waitForPresentation: async () => undefined
    });

    await Promise.resolve();
    controller.abort();
    finishExtract(["page"]);

    await expect(workflow).rejects.toMatchObject({ name: "AbortError" });
    expect(states).toEqual([{ extract: "active", analyze: "pending", store: "pending" }]);
    expect(analyze).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });
});

describe("live caption presentation", () => {
  it("keeps AWS stable partial text visually distinct while the unstable tail can still change", () => {
    const segments = [
      { segmentId: "one", revision: 1, text: "생성형 인공지능", stablePrefixLength: 3 },
      { segmentId: "two", revision: 1, text: "강연" }
    ];
    const stablePrefixLength = resolveStableInterimPrefixLength(segments);
    const presentation = resolveLiveCaptionPresentation([], "생성형 인공지능 강연", stablePrefixLength);
    const html = renderToStaticMarkup(createElement(LiveCaptionRows, {
      presentation,
      terms: [],
      sizeClass: LIVE_CAPTION_SIZE_CLASS.normal
    }));

    expect(stablePrefixLength).toBe(3);
    expect(html).toContain('<span class="caption-live-stable">생성형</span>');
    expect(html).toContain('<span class="caption-live-interim"> 인공지능 강연</span>');
  });
  const firstFinal = transcriptLine("line-1", "첫 번째 확정 자막.");
  const secondFinal = transcriptLine("line-2", "두 번째 확정 자막.");
  const thirdFinal = transcriptLine("line-3", "세 번째 확정 자막.");
  const fourthFinal = transcriptLine("line-4", "네 번째 확정 자막.");
  const placeholder = { kind: "placeholder", text: "마이크에 대고 강연을 시작해 주세요." } as const;

  it("composes provider final fragments until a contextual sentence boundary", () => {
    const fragments = [
      transcriptLine("fragment-1", "오늘은"),
      transcriptLine("fragment-2", "생성형 AI를"),
      transcriptLine("fragment-3", "설명합니다."),
      transcriptLine("fragment-4", "다음 문장입니다.")
    ];

    expect(endsCaptionSentence("설명합니다.")).toBe(true);
    expect(endsCaptionSentence("설명하는 중")).toBe(false);
    expect(captionJoinSeparator("생성형 AI를", "설명합니다.")).toBe(" ");
    expect(captionJoinSeparator("설명합니다", ", 이어집니다")).toBe("");
    expect(composeContextualCaptionLines(fragments)).toEqual([
      expect.objectContaining({
        id: "fragment-1",
        text: "오늘은 생성형 AI를 설명합니다."
      }),
      fragments[3]
    ]);
  });

  it("starts a new display row before an unfinished sentence becomes a slide-covering paragraph", () => {
    const first = transcriptLine("long-1", "가".repeat(LIVE_CAPTION_MAX_COMPOSED_CHARACTERS - 5));
    const second = transcriptLine("long-2", "나".repeat(10));

    expect(composeContextualCaptionLines([first, second])).toEqual([first, second]);
  });

  it("labels an empty live caption as waiting instead of confirmed", () => {
    expect(resolveCaptionDisplayState("placeholder", "connecting")).toEqual({ state: "waiting", label: "대기" });
    expect(resolveCaptionDisplayState("interim", "ready")).toEqual({ state: "partial", label: "인식 중" });
    expect(resolveCaptionDisplayState("final", "ready")).toEqual({ state: "final", label: "확정" });
    expect(resolveCaptionDisplayState("final", "error")).toEqual({ state: "error", label: "오류" });
  });

  it("keeps an unfinished confirmed prefix and its raw interim tail in one current paragraph", () => {
    const unfinished = transcriptLine("fragment-1", "오늘은 생성형 AI를");
    const presentation = resolveLiveCaptionPresentation([unfinished], "설명하고 있습니다");
    const html = renderToStaticMarkup(createElement(LiveCaptionRows, {
      presentation,
      terms: [],
      sizeClass: LIVE_CAPTION_SIZE_CLASS.normal
    }));

    expect(presentation).toEqual({
      historyLines: [],
      rows: [{ kind: "mixed", line: unfinished, interim: "설명하고 있습니다" }]
    });
    expect(html.match(/<p\b/g)).toHaveLength(1);
    expect(html).toContain("오늘은 생성형 AI를");
    expect(html).toContain("caption-live-interim");
    expect(html).toContain("설명하고 있습니다");
  });

  it("preserves correction offsets and source events when composed", () => {
    const prefix = transcriptLine("prefix", "오늘은");
    const corrected: TranscriptLine = {
      id: "corrected",
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
    const merged = mergeTranscriptLines(prefix, corrected);

    expect(merged).toMatchObject({
      id: "prefix",
      text: "오늘은 RAG를 설명합니다.",
      rawText: "오늘은 레그를 설명합니다.",
      termIds: ["rag"]
    });
    expect(merged.corrections[0]).toMatchObject({ displayStart: 4, displayEnd: 7 });
    expect(prefix.text).toBe("오늘은");
    expect(corrected.corrections[0]).toMatchObject({ displayStart: 0, displayEnd: 3 });
  });

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

    expect(resolveLiveCaptionPresentation(materializeTranscriptLines(state.transcript), state.interim).rows.at(-1)?.kind).toBe("placeholder");

    state = lectureStreamReducer(state, { type: "interim", text: "레그를 설명합니다." });
    const firstInterim = resolveLiveCaptionPresentation(materializeTranscriptLines(state.transcript), state.interim);
    expect(firstInterim).toEqual({
      historyLines: [], rows: [{ kind: "interim", text: "레그를 설명합니다." }]
    });

    state = lectureStreamReducer(state, { type: "interim", text: "레그를 자세히 설명합니다." });
    const continuedInterim = resolveLiveCaptionPresentation(materializeTranscriptLines(state.transcript), state.interim);
    expect(continuedInterim.rows).toHaveLength(firstInterim.rows.length);
    expect(continuedInterim.historyLines).toEqual(firstInterim.historyLines);
    expect(continuedInterim.rows.at(-1)).toEqual({ kind: "interim", text: "레그를 자세히 설명합니다." });

    state = lectureStreamReducer(state, {
      type: "final",
      line: correctedFirstFinal,
      occurrenceTermIds: ["rag"]
    });
    expect(state.interim).toBe("");
    expect(materializeTranscriptLines(state.transcript)[0]).toMatchObject({
      rawText: "레그를 설명합니다.",
      corrections: [correction]
    });
    expect(resolveLiveCaptionPresentation(materializeTranscriptLines(state.transcript), state.interim)).toEqual({
      historyLines: [],
      rows: [{ kind: "final", line: correctedFirstFinal }]
    });

    state = lectureStreamReducer(state, { type: "interim", text: "두 번째 임시 자막" });
    expect(resolveLiveCaptionPresentation(materializeTranscriptLines(state.transcript), state.interim)).toEqual({
      historyLines: [],
      rows: [
        { kind: "final", line: correctedFirstFinal },
        { kind: "interim", text: "두 번째 임시 자막" }
      ]
    });
    state = lectureStreamReducer(state, { type: "final", line: secondFinal, occurrenceTermIds: [] });
    expect(resolveLiveCaptionPresentation(materializeTranscriptLines(state.transcript), state.interim)).toEqual({
      historyLines: [],
      rows: [
        { kind: "final", line: correctedFirstFinal },
        { kind: "final", line: secondFinal }
      ]
    });

    state = lectureStreamReducer(state, { type: "interim", text: "세 번째 임시 자막" });
    expect(resolveLiveCaptionPresentation(materializeTranscriptLines(state.transcript), state.interim)).toEqual({
      historyLines: [],
      rows: [
        { kind: "final", line: correctedFirstFinal },
        { kind: "final", line: secondFinal },
        { kind: "interim", text: "세 번째 임시 자막" }
      ]
    });

    state = lectureStreamReducer(state, { type: "final", line: thirdFinal, occurrenceTermIds: [] });
    expect(resolveLiveCaptionPresentation(materializeTranscriptLines(state.transcript), state.interim)).toEqual({
      historyLines: [],
      rows: [
        { kind: "final", line: correctedFirstFinal },
        { kind: "final", line: secondFinal },
        { kind: "final", line: thirdFinal }
      ]
    });

    state = lectureStreamReducer(state, { type: "interim", text: "네 번째 임시 자막" });
    expect(resolveLiveCaptionPresentation(materializeTranscriptLines(state.transcript), state.interim)).toEqual({
      historyLines: [correctedFirstFinal],
      rows: [
        { kind: "final", line: secondFinal },
        { kind: "final", line: thirdFinal },
        { kind: "interim", text: "네 번째 임시 자막" }
      ]
    });

    state = lectureStreamReducer(state, { type: "final", line: fourthFinal, occurrenceTermIds: [] });
    expect(resolveLiveCaptionPresentation(materializeTranscriptLines(state.transcript), state.interim)).toEqual({
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
        presentation: resolveLiveCaptionPresentation(materializeTranscriptLines(state.transcript), state.interim),
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
    expect(resolveLiveCaptionPresentation(materializeTranscriptLines(state.transcript), state.interim)).toEqual({
      historyLines: [],
      rows: [{ kind: "final", line: firstFinal }]
    });

    state = lectureStreamReducer(state, { type: "final", line: secondFinal, occurrenceTermIds: [] });
    expect(resolveLiveCaptionPresentation(materializeTranscriptLines(state.transcript), state.interim)).toEqual({
      historyLines: [],
      rows: [
        { kind: "final", line: firstFinal },
        { kind: "final", line: secondFinal }
      ]
    });

    state = lectureStreamReducer(state, { type: "final", line: thirdFinal, occurrenceTermIds: [] });
    expect(resolveLiveCaptionPresentation(materializeTranscriptLines(state.transcript), state.interim)).toEqual({
      historyLines: [],
      rows: [
        { kind: "final", line: firstFinal },
        { kind: "final", line: secondFinal },
        { kind: "final", line: thirdFinal }
      ]
    });

    state = lectureStreamReducer(state, { type: "final", line: fourthFinal, occurrenceTermIds: [] });
    expect(resolveLiveCaptionPresentation(materializeTranscriptLines(state.transcript), state.interim)).toEqual({
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

  it("keeps visual partial text silent and announces only confirmed text", () => {
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
    expect(currentTag).not.toContain("aria-live");
    expect(currentTag).not.toContain("aria-atomic");
    expect(html).toContain('class="sr-only" role="status" aria-live="polite" aria-atomic="true" data-caption-announcement-id="line-2"');
    expect(html).toContain('>두 번째 확정 자막.</span>');
    expect(html).not.toContain('aria-live="polite" aria-atomic="true">다음 임시 자막');
  });

  it("keeps one fixed current wrapper key across interim-to-final updates", () => {
    expect(resolveLiveCaptionRowKey({ kind: "interim", text: "두 번째 임시 자막" }, true)).toBe(
      LIVE_CAPTION_CURRENT_KEY
    );
    expect(resolveLiveCaptionRowKey({ kind: "final", line: secondFinal }, true)).toBe(
      LIVE_CAPTION_CURRENT_KEY
    );

    const interimHtml = renderToStaticMarkup(createElement(LiveCaptionRows, {
      presentation: resolveLiveCaptionPresentation([firstFinal], "두 번째 임시 자막"),
      terms: [],
      sizeClass: LIVE_CAPTION_SIZE_CLASS.normal
    }));
    const finalHtml = renderToStaticMarkup(createElement(LiveCaptionRows, {
      presentation: resolveLiveCaptionPresentation([firstFinal, secondFinal], ""),
      terms: [],
      sizeClass: LIVE_CAPTION_SIZE_CLASS.normal
    }));

    expect(interimHtml).toContain('data-testid="live-caption-current"');
    expect(finalHtml).toContain('data-testid="live-caption-current"');
    expect(interimHtml).toContain('data-caption-kind="interim"');
    expect(finalHtml).toContain('data-caption-kind="final"');
    expect(finalHtml).toContain('aria-live="polite" aria-atomic="true"');
  });

  it.each([
    {
      name: "first interim",
      previous: resolveLiveCaptionPresentation([], ""),
      next: resolveLiveCaptionPresentation([], "첫 임시"),
      expected: []
    },
    {
      name: "next utterance interim",
      previous: resolveLiveCaptionPresentation([firstFinal, secondFinal], ""),
      next: resolveLiveCaptionPresentation([firstFinal, secondFinal], "세 번째 임시"),
      expected: ["line-1", "line-2"]
    },
    {
      name: "repeated interim",
      previous: resolveLiveCaptionPresentation([firstFinal], "둘째 임시"),
      next: resolveLiveCaptionPresentation([firstFinal], "둘째 임시가 늘어남"),
      expected: []
    },
    {
      name: "interim to final",
      previous: resolveLiveCaptionPresentation([firstFinal], "둘째 임시"),
      next: resolveLiveCaptionPresentation([firstFinal, secondFinal], ""),
      expected: []
    },
    {
      name: "final-only utterance",
      previous: resolveLiveCaptionPresentation([firstFinal, secondFinal], ""),
      next: resolveLiveCaptionPresentation([firstFinal, secondFinal, thirdFinal], ""),
      expected: ["line-1", "line-2"]
    },
    {
      name: "fourth utterance rotates oldest",
      previous: resolveLiveCaptionPresentation([firstFinal, secondFinal, thirdFinal], ""),
      next: resolveLiveCaptionPresentation([firstFinal, secondFinal, thirdFinal], "넷째 임시"),
      expected: ["line-2", "line-3"]
    }
  ])("gates promotion for $name", ({ previous, next, expected }) => {
    expect(resolveRetainedFinalPromotions(
      createLiveCaptionMotionSnapshot(previous),
      createLiveCaptionMotionSnapshot(next)
    )).toEqual(expected);
  });

  it("uses measured variable-height rect deltas and animates retained finals only", () => {
    const calls: Array<{ id: string; keyframes: Keyframe[]; options: KeyframeAnimationOptions }> = [];
    const handles = new Map<string, { cancel: () => void; onfinish: (() => void) | null; oncancel: (() => void) | null }>();
    const elements = new Map(["line-1", "line-2", "line-3"].map((id) => [id, {
      animate(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
        calls.push({ id, keyframes, options });
        const handle = { cancel: () => undefined, onfinish: null, oncancel: null };
        handles.set(id, handle);
        return handle;
      }
    }]));
    const active = new Map();

    expect(calculateCaptionFlipDelta(182.5, 71)).toBe(111.5);
    expect(runCaptionPromotionAnimations({
      retainedFinalIds: ["line-1", "line-2"],
      previousRects: new Map([["line-1", { top: 182.5 }], ["line-2", { top: 230 }]]),
      nextRects: new Map([["line-1", { top: 71 }], ["line-2", { top: 118.5 }], ["line-3", { top: 230 }]]),
      elements,
      reducedMotion: false,
      activeAnimations: active
    })).toEqual(["line-1", "line-2"]);
    expect(calls.map(({ id }) => id)).toEqual(["line-1", "line-2"]);
    expect(calls[0]?.keyframes).toEqual([
      { transform: "translate3d(0, 111.5px, 0)" },
      { transform: "translate3d(0, 0, 0)" }
    ]);
    expect(calls[1]?.keyframes[0]).toEqual({ transform: "translate3d(0, 111.5px, 0)" });
    expect(calls[0]?.options).toMatchObject({ duration: LIVE_CAPTION_PROMOTION_DURATION_MS });
    expect(calls.some(({ id }) => id === "line-3")).toBe(false);
  });

  it("cancels owned motion on rapid updates and skips all motion for reduced motion", () => {
    let cancelled = 0;
    let animateCalls = 0;
    const active = new Map<string, { cancel: () => void; onfinish: (() => void) | null; oncancel: (() => void) | null }>([[
      "line-1",
      { cancel: () => { cancelled += 1; }, onfinish: null, oncancel: null }
    ]]);
    const elements = new Map([["line-1", {
      animate() {
        animateCalls += 1;
        return { cancel: () => { cancelled += 1; }, onfinish: null, oncancel: null };
      }
    }]]);
    const geometry = new Map([["line-1", { top: 100 }]]);

    expect(runCaptionPromotionAnimations({
      retainedFinalIds: ["line-1"],
      previousRects: new Map([["line-1", { top: 180 }]]),
      nextRects: geometry,
      elements,
      reducedMotion: true,
      activeAnimations: active
    })).toEqual([]);
    expect(cancelled).toBe(1);
    expect(animateCalls).toBe(0);
    expect(active.size).toBe(0);
  });

  it("clears owned animation bookkeeping before cancel callbacks run", () => {
    const active = new Map<string, { cancel: () => void; onfinish: Animation["onfinish"]; oncancel: Animation["oncancel"] }>();
    const sizeSeenDuringCancel: number[] = [];
    active.set("line-1", {
      cancel: () => sizeSeenDuringCancel.push(active.size),
      onfinish: null,
      oncancel: null
    });

    cancelCaptionAnimations(active);

    expect(sizeSeenDuringCancel).toEqual([0]);
    expect(active.size).toBe(0);
  });

  it("degrades to an immediate layout when Web Animations is unavailable", () => {
    expect(runCaptionPromotionAnimations({
      retainedFinalIds: ["line-1"],
      previousRects: new Map([["line-1", { top: 180 }]]),
      nextRects: new Map([["line-1", { top: 100 }]]),
      elements: new Map(),
      reducedMotion: false,
      activeAnimations: new Map()
    })).toEqual([]);
  });

  it("keeps the new bottom row instant and reserves three bottom-aligned rows at the selected caption scale", () => {
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
    expect(liveLineRule).toMatch(/text-wrap:\s*wrap/);
    expect(liveLineRule).toMatch(/overflow-wrap:\s*break-word/);
    expect(liveLineRule).toMatch(/word-break:\s*normal/);
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
    expect(stylesheet.match(/\.caption-live-current\s*\{([^}]*)\}/)?.[1]).toMatch(/background:\s*var\(--caption-live-surface\)/);
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

  it("keeps text-only captions readable on bright slides without enabling the opaque scrim", () => {
    const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const scrimRule = stylesheet.match(/\.presentation-caption-overlay::before\s*\{([^}]*)\}/)?.[1];

    expect(scrimRule).toMatch(/opacity:\s*0/);
    expect(stylesheet).toContain("-webkit-text-stroke: .035em var(--color-stage-canvas)");
    expect(stylesheet).toContain("paint-order: stroke fill");
    expect(stylesheet).toContain("-1px -1px 1px var(--color-stage-canvas)");
    expect(stylesheet).toContain("1px 1px 1px var(--color-stage-canvas)");
    expect(stylesheet).toContain(".presentation-caption-overlay mark { -webkit-text-stroke: 0; text-shadow: none; }");
  });

  it("keeps presentation controls inside 667x375 landscape, 320x568, and 200% zoom viewports", () => {
    const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const stageRule = stylesheet.match(/\.presentation-stage\s*\{([^}]*)\}/)?.[1];
    const fullscreenRule = stylesheet.match(/\.presentation-stage:fullscreen\s*\{([^}]*)\}/)?.[1];

    expect(stageRule).toMatch(/height:\s*100dvh/);
    expect(stageRule).toMatch(/min-height:\s*0/);
    expect(stageRule).not.toMatch(/min-height:\s*32rem/);
    expect(fullscreenRule).toMatch(/min-height:\s*0/);
    expect(stylesheet).toContain("@media (max-height: 31.99rem)");
    expect(stylesheet).toContain("max-height: calc(100dvh - 16px)");
    expect(stylesheet).toContain("overflow-y: auto");
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
    expect(experimentHtml).toContain("STT 실험실 불러오는 중");
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
    expect(shouldSyncGlossaryStorageEvent(GLOSSARY_STORAGE_KEY)).toBe(true);
    expect(shouldSyncGlossaryStorageEvent(GLOSSARY_STORAGE_RECOVERY_KEY)).toBe(true);
    expect(shouldSyncGlossaryStorageEvent(null)).toBe(true);
    expect(shouldSyncGlossaryStorageEvent("another-app.key")).toBe(false);
  });
});

describe("session result preservation", () => {
  it("offers complete exports and explains the loss boundary before navigation", () => {
    const state = lectureStreamReducer(createInitialLectureStreamState(), {
      type: "final",
      line: transcriptLine("line-1", "확정 자막입니다."),
      occurrenceTermIds: []
    });
    const analysis: AnalysisResult = {
      title: "결과 보존 강연",
      pages: [{ pageNumber: 1, text: "확정 자막입니다." }],
      terms: [{
        id: "term-1",
        term: "자막",
        english: "caption",
        spokenAliases: [],
        easyExplanation: "말을 화면에 표시한 글",
        pageNumber: 1,
        occurrences: 1,
        source: "demo"
      }],
      phraseSet: ["자막"],
      mode: "demo"
    };

    const html = renderToStaticMarkup(createElement(ResultsScreen, {
      analysis,
      transcript: state.transcript,
      outcome: { status: "completed", reason: "server-ended", message: "완료" },
      lastMode: "live",
      exportState: { status: "not-exported", busy: false, error: "" },
      exportActions: { json: () => undefined, text: () => undefined, confirm: () => undefined },
      onRestart: () => undefined,
      onReady: () => undefined,
      onHome: () => undefined
    }));

    expect(html).toContain("결과 JSON 저장");
    expect(html).toContain("자막 TXT 저장");
    expect(html).toContain("파일 생성을 확인하지 않고 나가면 확인 창");
    expect(html).toContain("AWS 자막 스트림이 끝났고 마지막 확정 자막까지 수신했습니다.");
  });
});

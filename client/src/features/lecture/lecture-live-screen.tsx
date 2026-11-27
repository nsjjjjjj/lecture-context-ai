import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Highlighter,
  LoaderCircle,
  Maximize2,
  MonitorUp,
  Pause,
  Sparkles,
  Volume2,
  Wifi,
  WifiOff,
  X
} from "lucide-react";
import { PresentationPdfCanvas } from "../../components/PresentationPdfCanvas";
import {
  createInitialPresentationPdfCanvasState,
  resolvePresentationPageIndicator
} from "../../components/presentation-pdf-canvas-state";
import { TransparentCaption } from "../../components/TransparentCaption";
import { useLectureStream } from "../../hooks/useLectureStream";
import { lastTranscriptLine } from "../../hooks/transcript-store";
import {
  applyPresentationPageAction,
  clampPresentationPage,
  isEditableKeyboardTarget,
  presentationPageActionFromKey,
  type PresentationAsset
} from "../../lib/presentation";
import type { AnalysisResult, GlossaryTerm, TranscriptLine } from "../../types";
import {
  LIVE_CAPTION_SIZE_CLASS,
  cancelCaptionAnimations,
  captionJoinSeparator,
  createLiveCaptionMotionSnapshot,
  resolveCaptionDisplayState,
  resolveLiveCaptionRowsFromComposed,
  resolveLiveCaptionRowKey,
  resolveRetainedFinalPromotions,
  resolveStableInterimPrefixLength,
  runCaptionPromotionAnimations,
  type CaptionAnimatable,
  type CaptionAnimationLike,
  type CaptionRect,
  type FontScale,
  type LiveCaptionMotionSnapshot,
  type LiveCaptionPresentation,
  type LiveCaptionSlotState
} from "../captions/live-caption-model";
import { APP_MAIN_CONTENT_ID } from "./lecture-screen-contract";

const EMPTY_TRANSCRIPT_LINES: TranscriptLine[] = [];

function StableInterimText({ text, stablePrefixLength = 0 }: { text: string; stablePrefixLength?: number }) {
  const splitAt = Math.min(text.length, Math.max(0, stablePrefixLength));
  return (
    <>
      {splitAt > 0 ? <span className="caption-live-stable">{text.slice(0, splitAt)}</span> : null}
      {splitAt < text.length ? <span className="caption-live-interim">{text.slice(splitAt)}</span> : null}
    </>
  );
}


export function LiveCaptionSlot({
  slot,
  terms,
  sizeClass
}: {
  slot: LiveCaptionSlotState;
  terms: GlossaryTerm[];
  sizeClass: string;
}) {
  const className = `caption-live-line ${sizeClass}`;

  if (slot.kind === "final" || slot.kind === "mixed") {
    const trailingContent = slot.kind === "mixed"
      ? <span>{captionJoinSeparator(slot.line.text, slot.interim)}<StableInterimText text={slot.interim} stablePrefixLength={slot.stablePrefixLength} /></span>
      : undefined;
    return <TransparentCaption line={slot.line} terms={terms} className={className} trailingContent={trailingContent} />;
  }

  return (
    <p
      lang="ko"
      className={`caption-text ${className}${slot.kind === "interim" ? " caption-live-interim" : ""}${slot.kind === "placeholder" ? " text-slate-600" : ""}`}
    >
      {slot.kind === "interim" ? <StableInterimText text={slot.text} stablePrefixLength={slot.stablePrefixLength} /> : slot.text}
    </p>
  );
}

export type FinalCaptionAnnouncement = {
  id: string;
  text: string;
};

export function LiveCaptionRows({
  presentation,
  terms,
  sizeClass,
  finalAnnouncement: explicitFinalAnnouncement
}: {
  presentation: LiveCaptionPresentation;
  terms: GlossaryTerm[];
  sizeClass: string;
  finalAnnouncement?: FinalCaptionAnnouncement;
}) {
  const stackRef = useRef<HTMLDivElement>(null);
  const previousSnapshotRef = useRef<LiveCaptionMotionSnapshot | null>(null);
  const previousRectsRef = useRef<Map<string, CaptionRect>>(new Map());
  const activeAnimationsRef = useRef<Map<string, CaptionAnimationLike>>(new Map());
  const previousRows = presentation.rows.slice(0, -1);
  const currentRow = presentation.rows.at(-1)!;
  const latestFinalRow = [...presentation.rows].reverse().find(
    (row): row is Extract<LiveCaptionSlotState, { kind: "final" | "mixed" }> => row.kind === "final" || row.kind === "mixed"
  );
  const finalAnnouncement = explicitFinalAnnouncement ?? (latestFinalRow ? {
    id: latestFinalRow.line.id,
    text: latestFinalRow.line.text
  } : null);
  const motionSnapshot = createLiveCaptionMotionSnapshot(presentation);
  const motionSignature = `${sizeClass}|${presentation.rows.map((row) => {
    if (row.kind === "final") return `final:${row.line.id}:${row.line.text}`;
    if (row.kind === "mixed") return `mixed:${row.line.id}:${row.line.text}`;
    return row.kind;
  }).join("\u0000")}`;

  useLayoutEffect(() => {
    const stack = stackRef.current;
    if (!stack) return;

    const elements = new Map<string, CaptionAnimatable>();
    const nextRects = new Map<string, CaptionRect>();
    for (const row of stack.querySelectorAll<HTMLElement>("[data-caption-final-id]")) {
      const id = row.dataset.captionFinalId;
      if (!id) continue;
      nextRects.set(id, row.getBoundingClientRect());
      if (typeof row.animate === "function") elements.set(id, row);
    }

    runCaptionPromotionAnimations({
      retainedFinalIds: resolveRetainedFinalPromotions(previousSnapshotRef.current, motionSnapshot),
      previousRects: previousRectsRef.current,
      nextRects,
      elements,
      reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      activeAnimations: activeAnimationsRef.current
    });
    previousSnapshotRef.current = motionSnapshot;
    previousRectsRef.current = nextRects;
  }, [motionSignature]);

  useEffect(() => {
    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const cancelOwnedAnimations = () => {
      if (!motionPreference.matches) return;
      cancelCaptionAnimations(activeAnimationsRef.current);
    };
    motionPreference.addEventListener("change", cancelOwnedAnimations);
    return () => {
      motionPreference.removeEventListener("change", cancelOwnedAnimations);
      cancelCaptionAnimations(activeAnimationsRef.current);
    };
  }, []);

  return (
    <div ref={stackRef} className={`caption-live-stack ${sizeClass}`} data-testid="live-caption-rows">
      {previousRows.map((slot) => (
        <div
          key={resolveLiveCaptionRowKey(slot)}
          className="caption-live-row"
          data-testid="live-caption-previous"
          data-caption-kind={slot.kind}
          data-caption-final-id={slot.kind === "final" || slot.kind === "mixed" ? slot.line.id : undefined}
        >
          <LiveCaptionSlot slot={slot} terms={terms} sizeClass={sizeClass} />
        </div>
      ))}
      <div
        key={resolveLiveCaptionRowKey(currentRow, true)}
        className="caption-live-row caption-live-current"
        data-testid="live-caption-current"
        data-caption-kind={currentRow.kind}
        data-caption-final-id={currentRow.kind === "final" || currentRow.kind === "mixed" ? currentRow.line.id : undefined}
      >
        <LiveCaptionSlot slot={currentRow} terms={terms} sizeClass={sizeClass} />
      </div>
      <span
        key={finalAnnouncement?.id ?? "no-final-caption"}
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-caption-announcement-id={finalAnnouncement?.id}
      >
        {finalAnnouncement?.text ?? ""}
      </span>
    </div>
  );
}

export function LiveScreen({
  analysis,
  presentation,
  stream,
  fontScale,
  onFontScale,
  highContrast,
  onHighContrast,
  onFinish
}: {
  analysis: AnalysisResult;
  presentation: PresentationAsset | null;
  stream: ReturnType<typeof useLectureStream>;
  fontScale: FontScale;
  onFontScale: () => void;
  highContrast: boolean;
  onHighContrast: () => void;
  onFinish: () => void;
}) {
  const stageRef = useRef<HTMLElement>(null);
  const termById = useMemo(() => new Map(analysis.terms.map((term) => [term.id, term])), [analysis.terms]);
  const composedCaptionLines = stream.captionTail;
  const stableInterimPrefixLength = useMemo(
    () => resolveStableInterimPrefixLength(stream.partialSegments),
    [stream.partialSegments]
  );
  const captionPresentation = useMemo(
    () => ({
      historyLines: EMPTY_TRANSCRIPT_LINES,
      rows: resolveLiveCaptionRowsFromComposed(composedCaptionLines, stream.interim, stableInterimPrefixLength)
    }),
    [composedCaptionLines, stableInterimPrefixLength, stream.interim]
  );
  const stageCaptionPresentation = useMemo(
    () => ({ ...captionPresentation, rows: captionPresentation.rows.slice(-2) }),
    [captionPresentation]
  );
  const sizeClass = LIVE_CAPTION_SIZE_CLASS[fontScale];
  const fontScaleLabel = fontScale === "xlarge" ? "매우 크게" : fontScale === "large" ? "크게" : "보통";
  const [pageNumber, setPageNumber] = useState(1);
  const [pdfViewState, setPdfViewState] = useState(() => createInitialPresentationPdfCanvasState(1));
  const [captionsVisible, setCaptionsVisible] = useState(true);
  const [termsVisible, setTermsVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenMessage, setFullscreenMessage] = useState("");
  const currentCaptionKind = stageCaptionPresentation.rows.at(-1)?.kind;
  const captionDisplayState = resolveCaptionDisplayState(currentCaptionKind, stream.status);
  const latestFinalLine = lastTranscriptLine(stream.transcript);
  const uniqueOccurrences = useMemo(() => {
    const seen = new Set<string>();
    return stream.termOccurrences.filter((occurrence) => {
      if (seen.has(occurrence.termId)) return false;
      seen.add(occurrence.termId);
      return termById.has(occurrence.termId);
    });
  }, [stream.termOccurrences, termById]);
  const visibleOccurrences = uniqueOccurrences.slice(0, 3);
  const hiddenTermCount = Math.max(0, uniqueOccurrences.length - visibleOccurrences.length);

  const toggleFullscreen = useCallback(async () => {
    const stageElement = stageRef.current;
    if (!stageElement) return;
    setFullscreenMessage("");
    try {
      if (document.fullscreenElement === stageElement) {
        await document.exitFullscreen();
        return;
      }
      if (!stageElement.requestFullscreen) {
        setFullscreenMessage("이 브라우저는 전체 화면을 지원하지 않습니다. 현재 모니터 화면으로 발표를 계속할 수 있습니다.");
        return;
      }
      await stageElement.requestFullscreen();
    } catch {
      setFullscreenMessage("전체 화면을 열지 못했습니다. 브라우저 권한을 확인하거나 현재 모니터 화면으로 계속하세요.");
    }
  }, []);

  useEffect(() => {
    setPageNumber(1);
    setPdfViewState(createInitialPresentationPdfCanvasState(1));
  }, [presentation?.id]);

  useEffect(() => {
    const syncFullscreen = () => setFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isEditableKeyboardTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (!event.repeat && key === "c") {
        event.preventDefault();
        setCaptionsVisible((visible) => !visible);
        return;
      }
      if (!event.repeat && key === "t") {
        event.preventDefault();
        setTermsVisible((visible) => !visible);
        return;
      }
      if (!event.repeat && key === "f") {
        event.preventDefault();
        void toggleFullscreen();
        return;
      }
      if (!presentation) return;
      const action = presentationPageActionFromKey(event.key);
      if (!action) return;
      event.preventDefault();
      setPageNumber((current) => applyPresentationPageAction(current, presentation.pageCount, action));
    };
    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, [presentation, toggleFullscreen]);

  const finishFromStage = async () => {
    if (document.fullscreenElement === stageRef.current) {
      try {
        await document.exitFullscreen();
      } catch {
        // The lecture can still end if the browser owns fullscreen state.
      }
    }
    onFinish();
  };

  const safePageNumber = presentation ? clampPresentationPage(pageNumber, presentation.pageCount) : 1;
  const pageIndicator = presentation
    ? resolvePresentationPageIndicator(safePageNumber, presentation.pageCount, pdfViewState)
    : null;

  return (
    <main id={APP_MAIN_CONTENT_ID} ref={stageRef} className={`presentation-stage outline-none ${highContrast ? "presentation-stage-contrast contrast-more" : ""}`} data-app-stage="live" data-fullscreen={fullscreen || undefined} tabIndex={-1}>
      <div className="presentation-stage-media">
        {presentation ? (
          <PresentationPdfCanvas
            asset={presentation}
            pageNumber={safePageNumber}
            onViewStateChange={setPdfViewState}
          />
        ) : (
          <div className="presentation-monitor-fallback">
            <MonitorUp aria-hidden="true" />
            <strong>발표 PDF 없이 자막 모드로 진행 중</strong>
            <span>종료 후 준비 화면에서 발표 PDF를 별도로 선택할 수 있습니다.</span>
          </div>
        )}
      </div>

      <div className="presentation-status-bar">
        <div className="presentation-status-message" data-status={stream.status} role={stream.status === "error" ? "alert" : "status"}>
          {stream.status === "ready" ? <Wifi aria-hidden="true" /> : stream.status === "error" ? <WifiOff aria-hidden="true" /> : <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
          <span>{stream.statusMessage}</span>
        </div>
        <span className="presentation-title">{analysis.title}</span>
      </div>

      {termsVisible ? (
        <aside className="presentation-term-rail" aria-label="현재 용어 설명">
          {visibleOccurrences.length > 0 ? visibleOccurrences.map((occurrence, index) => {
            const term = termById.get(occurrence.termId)!;
            return (
              <article key={occurrence.id} className="presentation-term-card" data-latest={index === 0 || undefined}>
                <div>
                  <h2>{term.term}</h2>
                  {term.english ? <span>{term.english}</span> : null}
                </div>
                <p>{term.easyExplanation}</p>
              </article>
            );
          }) : (
            <div className="presentation-term-empty">
              <Sparkles aria-hidden="true" />
              <span>확정 자막에 용어가 나오면 설명이 표시됩니다.</span>
            </div>
          )}
          {hiddenTermCount > 0 ? <div className="presentation-term-overflow">이전 용어 +{hiddenTermCount}</div> : null}
        </aside>
      ) : null}

      {captionsVisible ? (
        <section className="presentation-caption-overlay" aria-label="현재 라이브 자막" data-caption-state={captionDisplayState.state}>
          <div className="presentation-caption-state">
            <Volume2 aria-hidden="true" />
            <span>{captionDisplayState.label}</span>
          </div>
          <LiveCaptionRows
            presentation={stageCaptionPresentation}
            terms={analysis.terms}
            sizeClass={sizeClass}
            finalAnnouncement={latestFinalLine ? {
              id: latestFinalLine.id,
              text: latestFinalLine.text
            } : undefined}
          />
        </section>
      ) : null}

      <div className="presentation-controls" aria-label="발표 제어">
        <div className="presentation-page-controls">
          <button
            type="button"
            disabled={!presentation || safePageNumber <= 1}
            onClick={() => presentation && setPageNumber((current) => applyPresentationPageAction(current, presentation.pageCount, "previous"))}
            aria-label="이전 페이지"
            title="이전 페이지 (← 또는 Page Up)"
          >
            <ArrowLeft aria-hidden="true" />
          </button>
          <span
            aria-live="polite"
            aria-atomic="true"
            aria-label={pageIndicator?.ariaLabel}
            data-page-status={pageIndicator?.status}
          >
            {pageIndicator?.label ?? "PDF 없음"}
          </span>
          <button
            type="button"
            disabled={!presentation || safePageNumber >= presentation.pageCount}
            onClick={() => presentation && setPageNumber((current) => applyPresentationPageAction(current, presentation.pageCount, "next"))}
            aria-label="다음 페이지"
            title="다음 페이지 (→, Page Down 또는 Space)"
          >
            <ArrowRight aria-hidden="true" />
          </button>
        </div>
        <button type="button" onClick={() => setCaptionsVisible((visible) => !visible)} aria-pressed={captionsVisible} title="자막 표시 (C)">
          <Volume2 aria-hidden="true" /><span>자막</span><kbd>C</kbd>
        </button>
        <button type="button" onClick={() => setTermsVisible((visible) => !visible)} aria-pressed={termsVisible} title="용어 카드 표시 (T)">
          <Sparkles aria-hidden="true" /><span>용어</span><kbd>T</kbd>
        </button>
        <button type="button" onClick={onFontScale} aria-label={`자막 글자 크기 변경, 현재 ${fontScaleLabel}`} title={`자막 크기: ${fontScaleLabel}`}>
          <span aria-hidden="true" className="presentation-font-icon">가</span><span className="control-label">크기</span>
        </button>
        <button type="button" onClick={onHighContrast} aria-pressed={highContrast} title="고대비 화면 전환">
          <Highlighter aria-hidden="true" /><span className="control-label">대비</span>
        </button>
        <button type="button" onClick={() => void toggleFullscreen()} aria-pressed={fullscreen} title="전체 화면 (F)">
          <Maximize2 aria-hidden="true" /><span>전체 화면</span><kbd>F</kbd>
        </button>
        <button type="button" className="presentation-end-button" onClick={() => void finishFromStage()}>
          <Pause aria-hidden="true" /> 종료
        </button>
      </div>

      {fullscreenMessage ? (
        <div className="presentation-stage-alert" role="alert">
          <span>{fullscreenMessage}</span>
          <button type="button" onClick={() => setFullscreenMessage("")} aria-label="전체 화면 안내 닫기"><X aria-hidden="true" /></button>
        </div>
      ) : null}
    </main>
  );
}



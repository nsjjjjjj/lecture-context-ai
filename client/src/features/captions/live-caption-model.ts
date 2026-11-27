import type {
  LectureStreamStatus,
  TranscriptPartialSegment
} from "../../hooks/lecture-stream-state";
import type { TranscriptLine } from "../../types";
import {
  captionJoinSeparator,
  composeContextualCaptionLines,
  endsCaptionSentence
} from "./contextual-caption";
export {
  LIVE_CAPTION_MAX_COMPOSED_CHARACTERS,
  captionJoinSeparator,
  composeContextualCaptionLines,
  endsCaptionSentence,
  mergeTranscriptLines
} from "./contextual-caption";

export type FontScale = "normal" | "large" | "xlarge";

export type LiveCaptionSlotState =
  | { kind: "interim"; text: string; stablePrefixLength?: number }
  | { kind: "mixed"; line: TranscriptLine; interim: string; stablePrefixLength?: number }
  | { kind: "final"; line: TranscriptLine }
  | { kind: "placeholder"; text: string };

export type LiveCaptionPresentation = {
  historyLines: TranscriptLine[];
  rows: LiveCaptionSlotState[];
};

export type LiveCaptionMotionSnapshot = {
  currentKind: LiveCaptionSlotState["kind"];
  currentFinalId: string | null;
  finalIds: string[];
};

export type CaptionAnimationLike = {
  cancel: () => void;
  onfinish: Animation["onfinish"];
  oncancel: Animation["oncancel"];
};

export type CaptionAnimatable = {
  animate: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => CaptionAnimationLike;
};

export type CaptionRect = { top: number };

export const LIVE_CAPTION_PROMOTION_DURATION_MS = 240;
export const LIVE_CAPTION_CURRENT_KEY = "live-caption-current";

export const LIVE_CAPTION_SIZE_CLASS: Record<FontScale, string> = {
  normal: "caption-normal text-xl sm:text-2xl",
  large: "caption-large text-2xl sm:text-[1.9rem]",
  xlarge: "caption-xlarge text-[1.8rem] sm:text-[2.3rem]"
};

const LIVE_CAPTION_PLACEHOLDER = "마이크에 대고 강연을 시작해 주세요.";

export function resolveCaptionDisplayState(
  kind: LiveCaptionSlotState["kind"] | undefined,
  streamStatus: LectureStreamStatus
): { state: "waiting" | "partial" | "final" | "error"; label: string } {
  if (streamStatus === "error") return { state: "error", label: "오류" };
  if (!kind || kind === "placeholder") return { state: "waiting", label: "대기" };
  if (kind === "interim" || kind === "mixed") return { state: "partial", label: "인식 중" };
  return { state: "final", label: "확정" };
}

export function resolveLiveCaptionPresentation(
  lines: TranscriptLine[],
  interim: string,
  stablePrefixLength = 0
): LiveCaptionPresentation {
  return resolveLiveCaptionPresentationFromComposed(composeContextualCaptionLines(lines), interim, stablePrefixLength);
}

export function resolveLiveCaptionPresentationFromComposed(
  composedLines: TranscriptLine[],
  interim: string,
  stablePrefixLength = 0
): LiveCaptionPresentation {
  const projection = projectLiveCaptionWindow(composedLines, interim, stablePrefixLength);
  return {
    historyLines: composedLines.slice(0, projection.historyEndIndex),
    rows: projection.rows
  };
}

function projectLiveCaptionWindow(
  composedLines: TranscriptLine[],
  interim: string,
  stablePrefixLength: number
): { historyEndIndex: number; rows: LiveCaptionSlotState[] } {
  const hasInterim = Boolean(interim.trim());
  const lastFinal = composedLines.at(-1);
  const continuesCurrentSentence = Boolean(hasInterim && lastFinal && !endsCaptionSentence(lastFinal.text));
  const stableMetadata = stablePrefixLength > 0 ? { stablePrefixLength } : {};
  const visibleFinalLimit = hasInterim && !continuesCurrentSentence ? 2 : 3;
  const visibleFinals = composedLines.slice(-visibleFinalLimit);
  const rows: LiveCaptionSlotState[] = visibleFinals.map((line, index) => {
    const isLast = index === visibleFinals.length - 1;
    return continuesCurrentSentence && isLast
      ? { kind: "mixed", line, interim, ...stableMetadata }
      : { kind: "final", line };
  });

  if (hasInterim && !continuesCurrentSentence) {
    rows.push({ kind: "interim", text: interim, ...stableMetadata });
  } else if (rows.length === 0) {
    rows.push({ kind: "placeholder", text: LIVE_CAPTION_PLACEHOLDER });
  }

  return { historyEndIndex: Math.max(0, composedLines.length - visibleFinalLimit), rows };
}

/** Hot-path projection for live partial updates; it never copies the full transcript history. */
export function resolveLiveCaptionRowsFromComposed(
  composedLines: TranscriptLine[],
  interim: string,
  stablePrefixLength = 0
): LiveCaptionSlotState[] {
  return projectLiveCaptionWindow(composedLines, interim, stablePrefixLength).rows;
}

export function resolveStableInterimPrefixLength(segments: TranscriptPartialSegment[]): number {
  let prefixLength = 0;
  let hasPreviousText = false;
  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;
    const stableLength = Math.min(text.length, Math.max(0, segment.stablePrefixLength ?? 0));
    if (hasPreviousText) prefixLength += 1;
    prefixLength += stableLength;
    if (stableLength < text.length) break;
    hasPreviousText = true;
  }
  return prefixLength;
}

export function createLiveCaptionMotionSnapshot(
  presentation: LiveCaptionPresentation
): LiveCaptionMotionSnapshot {
  const current = presentation.rows.at(-1)!;
  return {
    currentKind: current.kind,
    currentFinalId: current.kind === "final" || current.kind === "mixed" ? current.line.id : null,
    finalIds: presentation.rows.flatMap((row) =>
      row.kind === "final" || row.kind === "mixed" ? [row.line.id] : []
    )
  };
}

export function resolveRetainedFinalPromotions(
  previous: LiveCaptionMotionSnapshot | null,
  next: LiveCaptionMotionSnapshot
): string[] {
  if (!previous || (previous.currentKind !== "final" && previous.currentKind !== "mixed")) return [];

  const startsNewUtterance = next.currentKind === "interim"
    || ((next.currentKind === "final" || next.currentKind === "mixed")
      && next.currentFinalId !== previous.currentFinalId);
  if (!startsNewUtterance) return [];

  const nextFinalIds = new Set(next.finalIds);
  return previous.finalIds.filter((id) => nextFinalIds.has(id));
}

export function calculateCaptionFlipDelta(previousTop: number, nextTop: number): number {
  return previousTop - nextTop;
}

export function cancelCaptionAnimations(activeAnimations: Map<string, CaptionAnimationLike>): void {
  const animations = [...activeAnimations.values()];
  activeAnimations.clear();
  for (const animation of animations) animation.cancel();
}

export function resolveLiveCaptionRowKey(slot: LiveCaptionSlotState, current = false): string {
  if (current) return LIVE_CAPTION_CURRENT_KEY;
  return slot.kind === "final" || slot.kind === "mixed" ? slot.line.id : slot.kind;
}

export function runCaptionPromotionAnimations({
  retainedFinalIds,
  previousRects,
  nextRects,
  elements,
  reducedMotion,
  activeAnimations
}: {
  retainedFinalIds: string[];
  previousRects: ReadonlyMap<string, CaptionRect>;
  nextRects: ReadonlyMap<string, CaptionRect>;
  elements: ReadonlyMap<string, CaptionAnimatable>;
  reducedMotion: boolean;
  activeAnimations: Map<string, CaptionAnimationLike>;
}): string[] {
  cancelCaptionAnimations(activeAnimations);
  if (reducedMotion) return [];

  const animatedIds: string[] = [];
  for (const id of retainedFinalIds) {
    const element = elements.get(id);
    const previousRect = previousRects.get(id);
    const nextRect = nextRects.get(id);
    if (!element || !previousRect || !nextRect) continue;

    const delta = calculateCaptionFlipDelta(previousRect.top, nextRect.top);
    if (Math.abs(delta) < 0.5) continue;

    const animation = element.animate(
      [
        { transform: `translate3d(0, ${delta}px, 0)` },
        { transform: "translate3d(0, 0, 0)" }
      ],
      {
        duration: LIVE_CAPTION_PROMOTION_DURATION_MS,
        easing: "cubic-bezier(.22, 1, .36, 1)"
      }
    );
    const release = () => {
      if (activeAnimations.get(id) === animation) activeAnimations.delete(id);
    };
    animation.onfinish = release;
    animation.oncancel = release;
    activeAnimations.set(id, animation);
    animatedIds.push(id);
  }

  return animatedIds;
}

export function calculateHistoryRowScrollTop(
  currentScrollTop: number,
  containerBottom: number,
  rowBottom: number
): number {
  return Math.max(0, currentScrollTop, currentScrollTop + rowBottom - containerBottom);
}

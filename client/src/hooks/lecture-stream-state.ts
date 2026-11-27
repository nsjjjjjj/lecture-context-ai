import type { GlossaryTerm, TranscriptLine } from "../types";
import {
  appendContextualCaptionLine
} from "../features/captions/contextual-caption";
import {
  appendTranscriptLine,
  createTranscriptStore,
  type TranscriptStore
} from "./transcript-store";

export type LectureMode = "live" | "demo";
export type LectureStreamStatus = "idle" | "connecting" | "ready" | "stopping" | "ended" | "error";

export type LectureSessionOutcome =
  | {
      status: "completed";
      reason: "server-ended";
      message: string;
    }
  | {
      status: "flush-timeout";
      reason: "server-flush-timeout" | "client-flush-timeout" | "server-response-timeout";
      message: string;
    }
  | {
      status: "transport-error";
      reason:
        | "socket"
        | "socket-construction"
        | "socket-open-timeout"
        | "start-handshake-timeout"
        | "protocol"
        | "capture"
        | "server"
        | "start-request"
        | "stop-request";
      message: string;
    };

export type LectureStopOutcome =
  | LectureSessionOutcome
  | {
      status: "no-active-session";
      reason: "idle";
      message: string;
    }
  | {
      status: "cancelled-before-streaming";
      reason: "live-connecting" | "demo-connecting";
      message: string;
    }
  | {
      status: "cancelled";
      reason: "superseded";
      message: string;
    };

export type LectureStartOutcome =
  | {
      status: "opening";
      mode: LectureMode;
    }
  | {
      status: "failed";
      outcome: LectureSessionOutcome;
    }
  | {
      status: "cancelled";
      reason: "superseded";
      message: string;
    };

export type TermOccurrence = {
  id: string;
  termId: string;
  transcriptLineId: string;
};

export type TranscriptPartialSegment = {
  segmentId: string;
  revision: number;
  text: string;
  stablePrefixLength?: number;
  startTimeMs?: number;
  endTimeMs?: number;
};

export type LectureStreamState = {
  status: LectureStreamStatus;
  statusMessage: string;
  sessionOutcome: LectureSessionOutcome | null;
  interim: string;
  partialSegments: TranscriptPartialSegment[];
  finalizedSegmentIds: string[];
  transcript: TranscriptStore;
  captionTail: TranscriptLine[];
  termOccurrences: TermOccurrence[];
};

export type LectureStreamAction =
  | { type: "discard" }
  | { type: "starting"; mode: LectureMode }
  | { type: "connection-progress"; message: string }
  | { type: "ready"; message?: string }
  | { type: "stopping"; message?: string }
  | { type: "interim"; text: string }
  | ({ type: "partial" } & TranscriptPartialSegment)
  | {
      type: "final";
      line: TranscriptLine;
      occurrenceTermIds: string[];
      segmentId?: string;
      revision?: number;
    }
  | { type: "error"; message?: string; outcome?: Exclude<LectureSessionOutcome, { status: "completed" }> }
  | { type: "ended"; message?: string; outcome?: Extract<LectureSessionOutcome, { status: "completed" }> };

export const MAX_FINALIZED_SEGMENT_IDS = 512;
export const MAX_LIVE_CAPTION_TAIL_LINES = 3;

export function appendContextualCaptionTail(
  captionTail: TranscriptLine[],
  line: TranscriptLine
): TranscriptLine[] {
  return appendContextualCaptionLine(captionTail, line, MAX_LIVE_CAPTION_TAIL_LINES);
}

export function createInitialLectureStreamState(): LectureStreamState {
  return {
    status: "idle",
    statusMessage: "강연을 시작할 준비가 되었습니다.",
    sessionOutcome: null,
    interim: "",
    partialSegments: [],
    finalizedSegmentIds: [],
    transcript: createTranscriptStore(),
    captionTail: [],
    termOccurrences: []
  };
}

function joinPartialText(segments: TranscriptPartialSegment[]): string {
  return segments.map((segment) => segment.text.trim()).filter(Boolean).join(" ");
}

function orderPartialSegments(segments: TranscriptPartialSegment[]): TranscriptPartialSegment[] {
  return segments
    .map((segment, arrivalIndex) => ({ segment, arrivalIndex }))
    .sort((left, right) => {
      const leftStart = left.segment.startTimeMs;
      const rightStart = right.segment.startTimeMs;
      if (leftStart === undefined && rightStart === undefined) return left.arrivalIndex - right.arrivalIndex;
      if (leftStart === undefined) return 1;
      if (rightStart === undefined) return -1;
      return leftStart - rightStart || left.arrivalIndex - right.arrivalIndex;
    })
    .map(({ segment }) => segment);
}

export function lectureStreamReducer(state: LectureStreamState, action: LectureStreamAction): LectureStreamState {
  switch (action.type) {
    case "discard":
      return createInitialLectureStreamState();
    case "starting":
      return {
        ...state,
        status: "connecting",
        statusMessage: action.mode === "demo" ? "데모 자막을 준비하고 있습니다." : "마이크와 음성인식을 연결하고 있습니다.",
        sessionOutcome: null,
        interim: "",
        partialSegments: [],
        finalizedSegmentIds: [],
        transcript: createTranscriptStore(),
        captionTail: [],
        termOccurrences: []
      };
    case "ready":
      return { ...state, status: "ready", statusMessage: action.message || "강연 중" };
    case "connection-progress":
      return { ...state, status: "connecting", statusMessage: action.message };
    case "stopping":
      return { ...state, status: "stopping", statusMessage: action.message || "마지막 자막을 정리하고 있습니다." };
    case "interim":
      return { ...state, interim: action.text };
    case "partial": {
      if (state.finalizedSegmentIds.includes(action.segmentId)) return state;

      const existingIndex = state.partialSegments.findIndex(
        (segment) => segment.segmentId === action.segmentId
      );
      const existing = state.partialSegments[existingIndex];
      if (existing && action.revision <= existing.revision) return state;

      const nextSegment: TranscriptPartialSegment = {
        segmentId: action.segmentId,
        revision: action.revision,
        text: action.text,
        ...(action.stablePrefixLength === undefined ? {} : { stablePrefixLength: action.stablePrefixLength }),
        ...(action.startTimeMs === undefined ? {} : { startTimeMs: action.startTimeMs }),
        ...(action.endTimeMs === undefined ? {} : { endTimeMs: action.endTimeMs })
      };
      const nextPartialSegments = action.text.trim()
        ? existingIndex === -1
          ? [...state.partialSegments, nextSegment]
          : state.partialSegments.map((segment, index) => index === existingIndex ? nextSegment : segment)
        : state.partialSegments.filter((segment) => segment.segmentId !== action.segmentId);
      const partialSegments = orderPartialSegments(nextPartialSegments);

      return { ...state, partialSegments, interim: joinPartialText(partialSegments) };
    }
    case "final": {
      const partial = action.segmentId
        ? state.partialSegments.find((segment) => segment.segmentId === action.segmentId)
        : undefined;
      if (action.segmentId && state.finalizedSegmentIds.includes(action.segmentId)) return state;
      if (partial && action.revision !== undefined && action.revision <= partial.revision) return state;

      const latestOccurrences: TermOccurrence[] = [];
      const mentionedTermIds = new Set<string>();
      for (let occurrenceIndex = action.occurrenceTermIds.length - 1; occurrenceIndex >= 0; occurrenceIndex -= 1) {
        const termId = action.occurrenceTermIds[occurrenceIndex];
        if (!termId || mentionedTermIds.has(termId)) continue;
        mentionedTermIds.add(termId);
        latestOccurrences.push({
          id: `${action.line.id}:term:${occurrenceIndex}`,
          termId,
          transcriptLineId: action.line.id
        });
      }
      const partialSegments = action.segmentId
        ? state.partialSegments.filter((segment) => segment.segmentId !== action.segmentId)
        : [];
      return {
        ...state,
        interim: joinPartialText(partialSegments),
        partialSegments,
        finalizedSegmentIds: action.segmentId
          ? [...state.finalizedSegmentIds, action.segmentId].slice(-MAX_FINALIZED_SEGMENT_IDS)
          : state.finalizedSegmentIds,
        transcript: appendTranscriptLine(state.transcript, action.line),
        captionTail: appendContextualCaptionTail(state.captionTail, action.line),
        termOccurrences: [
          ...latestOccurrences,
          ...state.termOccurrences.filter((occurrence) => !mentionedTermIds.has(occurrence.termId))
        ]
      };
    }
    case "error": {
      const message = action.message || "자막 처리 중 오류가 발생했습니다.";
      return {
        ...state,
        status: "error",
        statusMessage: message,
        sessionOutcome: action.outcome ?? { status: "transport-error", reason: "server", message },
        interim: "",
        partialSegments: []
      };
    }
    case "ended": {
      const message = action.message || "강연이 끝났습니다.";
      return {
        ...state,
        status: "ended",
        statusMessage: message,
        sessionOutcome: action.outcome ?? { status: "completed", reason: "server-ended", message },
        interim: "",
        partialSegments: []
      };
    }
  }
}

export type LectureStartMessage = {
  type: "start";
  mode: LectureMode;
  terms: GlossaryTerm[];
  phraseSet: string[];
  vocabularyName?: string;
};

export function createLectureStartMessage(
  mode: LectureMode,
  terms: GlossaryTerm[],
  phraseSet: string[],
  vocabularyName?: string
): LectureStartMessage {
  return { type: "start", mode, terms, phraseSet, ...(vocabularyName ? { vocabularyName } : {}) };
}

export function shouldTransitionToResults(
  stage: string,
  previousStatus: LectureStreamStatus,
  status: LectureStreamStatus
): boolean {
  return stage === "live" && previousStatus !== "ended" && status === "ended";
}

export function isCurrentLectureSession(activeGeneration: number, eventGeneration: number): boolean {
  return activeGeneration === eventGeneration;
}

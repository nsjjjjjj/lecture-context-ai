import type { GlossaryTerm, TranscriptLine } from "../types";

export type LectureMode = "live" | "demo";
export type LectureStreamStatus = "idle" | "connecting" | "ready" | "stopping" | "ended" | "error";

export type TermOccurrence = {
  id: string;
  termId: string;
  transcriptLineId: string;
};

export type LectureStreamState = {
  status: LectureStreamStatus;
  statusMessage: string;
  interim: string;
  lines: TranscriptLine[];
  termOccurrences: TermOccurrence[];
};

export type LectureStreamAction =
  | { type: "starting"; mode: LectureMode }
  | { type: "connection-progress"; message: string }
  | { type: "ready"; message?: string }
  | { type: "stopping"; message?: string }
  | { type: "interim"; text: string }
  | { type: "final"; line: TranscriptLine; occurrenceTermIds: string[] }
  | { type: "error"; message?: string }
  | { type: "ended"; message?: string };

export function createInitialLectureStreamState(): LectureStreamState {
  return {
    status: "idle",
    statusMessage: "강연을 시작할 준비가 되었습니다.",
    interim: "",
    lines: [],
    termOccurrences: []
  };
}

export function lectureStreamReducer(state: LectureStreamState, action: LectureStreamAction): LectureStreamState {
  switch (action.type) {
    case "starting":
      return {
        ...state,
        status: "connecting",
        statusMessage: action.mode === "demo" ? "데모 자막을 준비하고 있습니다." : "마이크와 Google STT를 연결하고 있습니다.",
        interim: "",
        lines: [],
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
    case "final": {
      const latestOccurrences = action.occurrenceTermIds
        .map((termId, occurrenceIndex) => ({
          id: `${action.line.id}:term:${occurrenceIndex}`,
          termId,
          transcriptLineId: action.line.id
        }))
        .reverse();
      return {
        ...state,
        interim: "",
        lines: [...state.lines, action.line],
        termOccurrences: [...latestOccurrences, ...state.termOccurrences]
      };
    }
    case "error":
      return { ...state, status: "error", statusMessage: action.message || "자막 처리 중 오류가 발생했습니다." };
    case "ended":
      return {
        ...state,
        status: "ended",
        statusMessage: action.message || "강연이 끝났습니다.",
        interim: ""
      };
  }
}

export type LectureStartMessage = {
  type: "start";
  mode: LectureMode;
  terms: GlossaryTerm[];
  phraseSet: string[];
};

export function createLectureStartMessage(mode: LectureMode, terms: GlossaryTerm[], phraseSet: string[]): LectureStartMessage {
  return { type: "start", mode, terms, phraseSet };
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

import type { GlossaryTerm, TranscriptLine } from "../types";

export type LectureMode = "live" | "demo";
export type LectureStreamStatus = "idle" | "connecting" | "ready" | "ended" | "error";

export type LectureStreamState = {
  status: LectureStreamStatus;
  statusMessage: string;
  interim: string;
  lines: TranscriptLine[];
  activeTermId: string | null;
};

export type LectureStreamAction =
  | { type: "starting"; mode: LectureMode; activeTermId: string | null }
  | { type: "ready"; message?: string }
  | { type: "interim"; text: string; activeTermId?: string }
  | { type: "final"; line: TranscriptLine; activeTermId?: string }
  | { type: "error"; message?: string }
  | { type: "ended"; message?: string }
  | { type: "select-term"; termId: string | null };

export function createInitialLectureStreamState(activeTermId: string | null): LectureStreamState {
  return {
    status: "idle",
    statusMessage: "강연을 시작할 준비가 되었습니다.",
    interim: "",
    lines: [],
    activeTermId
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
        activeTermId: action.activeTermId
      };
    case "ready":
      return { ...state, status: "ready", statusMessage: action.message || "강연 중" };
    case "interim":
      return {
        ...state,
        interim: action.text,
        activeTermId: action.activeTermId || state.activeTermId
      };
    case "final":
      return {
        ...state,
        interim: "",
        lines: [...state.lines, action.line],
        activeTermId: action.activeTermId || state.activeTermId
      };
    case "error":
      return { ...state, status: "error", statusMessage: action.message || "자막 처리 중 오류가 발생했습니다." };
    case "ended":
      return {
        ...state,
        status: "ended",
        statusMessage: action.message || "강연이 끝났습니다.",
        interim: ""
      };
    case "select-term":
      return { ...state, activeTermId: action.termId };
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

export function shouldTransitionToResults(stage: string, status: LectureStreamStatus): boolean {
  return stage === "live" && status === "ended";
}

export function isCurrentLectureSession(activeGeneration: number, eventGeneration: number): boolean {
  return activeGeneration === eventGeneration;
}

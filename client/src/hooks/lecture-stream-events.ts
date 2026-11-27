import type {
  LegacyInterimTranscriptEvent,
  TranscriptCorrection,
  TranscriptControlEvent,
  TranscriptEvent,
  TranscriptSegmentEvent
} from "../types";

export const MAX_TRANSCRIPT_EVENT_JSON_CHARS = 1_000_000;
const MAX_TRANSCRIPT_TEXT_CHARS = 200_000;
const MAX_EVENT_ARRAY_ITEMS = 10_000;
const PUBLIC_PROTOCOL_ERROR_MESSAGE =
  "서버가 올바르지 않은 자막 데이터를 보냈습니다. 강연을 다시 시작해 주세요.";

export type LectureStreamControlEvent = TranscriptControlEvent;
export type LectureStreamServerEvent = TranscriptEvent;

export type LectureStreamEventParseResult =
  | { ok: true; event: LectureStreamServerEvent }
  | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown, maxLength = MAX_TRANSCRIPT_TEXT_CHARS): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length <= maxLength);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isOptionalNonNegativeFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_EVENT_ARRAY_ITEMS &&
    value.every((item) => typeof item === "string" && item.length <= MAX_TRANSCRIPT_TEXT_CHARS)
  );
}

function isTranscriptCorrection(value: unknown, displayTextLength: number): value is TranscriptCorrection {
  if (!isRecord(value)) return false;
  return (
    isOptionalString(value.originalText) &&
    typeof value.originalText === "string" &&
    isOptionalString(value.correctedText) &&
    typeof value.correctedText === "string" &&
    typeof value.termId === "string" &&
    value.termId.length > 0 &&
    value.termId.length <= 500 &&
    isNonNegativeInteger(value.displayStart) &&
    isNonNegativeInteger(value.displayEnd) &&
    value.displayStart <= value.displayEnd &&
    value.displayEnd <= displayTextLength &&
    value.reason === "spokenAlias"
  );
}

function isControlEvent(value: Record<string, unknown>): value is LectureStreamControlEvent {
  if (
    value.type !== "ready" &&
    value.type !== "captureRequested" &&
    value.type !== "readyForAudio" &&
    value.type !== "providerAccepted" &&
    value.type !== "status" &&
    value.type !== "error" &&
    value.type !== "ended"
  ) {
    return false;
  }
  if (!isOptionalString(value.message, 10_000)) return false;
  if (value.type !== "ended") return value.outcome === undefined;
  return value.outcome === "completed" || value.outcome === "flush-timeout";
}

function isLegacyInterimEvent(value: Record<string, unknown>): value is LegacyInterimTranscriptEvent {
  return (
    value.type === "interim" &&
    isOptionalString(value.text) &&
    (value.segmentId === undefined ||
      (typeof value.segmentId === "string" && value.segmentId.length > 0 && value.segmentId.length <= 500)) &&
    (value.revision === undefined || isNonNegativeInteger(value.revision))
  );
}

function isTranscriptSegmentEvent(value: Record<string, unknown>): value is TranscriptSegmentEvent {
  if (value.type !== "partial" && value.type !== "final") return false;
  const text = value.text;
  if (
    typeof value.segmentId !== "string" ||
    value.segmentId.length === 0 ||
    value.segmentId.length > 500 ||
    !isNonNegativeInteger(value.revision) ||
    typeof text !== "string" ||
    text.length === 0 ||
    text.length > MAX_TRANSCRIPT_TEXT_CHARS
  ) {
    return false;
  }
  if (
    !isOptionalString(value.providerResultId, 500) ||
    !isOptionalNonNegativeFiniteNumber(value.startTimeMs) ||
    !isOptionalNonNegativeFiniteNumber(value.endTimeMs) ||
    (value.startTimeMs !== undefined && value.endTimeMs !== undefined && value.endTimeMs < value.startTimeMs) ||
    (value.stablePrefixLength !== undefined &&
      (!isNonNegativeInteger(value.stablePrefixLength) || value.stablePrefixLength > text.length))
  ) {
    return false;
  }
  if (value.type === "partial") {
    return (
      value.rawText === undefined &&
      value.detectedTerms === undefined &&
      value.relatedPage === undefined &&
      value.corrections === undefined
    );
  }
  return (
    isOptionalString(value.rawText) &&
    (value.detectedTerms === undefined || isStringArray(value.detectedTerms)) &&
    (value.relatedPage === undefined || (Number.isInteger(value.relatedPage) && (value.relatedPage as number) > 0)) &&
    (value.corrections === undefined ||
      (Array.isArray(value.corrections) &&
        value.corrections.length <= MAX_EVENT_ARRAY_ITEMS &&
        value.corrections.every((correction) => isTranscriptCorrection(correction, text.length))))
  );
}

export function parseLectureStreamServerEvent(data: unknown): LectureStreamEventParseResult {
  if (typeof data !== "string" || data.length === 0 || data.length > MAX_TRANSCRIPT_EVENT_JSON_CHARS) {
    return { ok: false, message: PUBLIC_PROTOCOL_ERROR_MESSAGE };
  }

  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return { ok: false, message: PUBLIC_PROTOCOL_ERROR_MESSAGE };
  }

  if (!isRecord(value)) return { ok: false, message: PUBLIC_PROTOCOL_ERROR_MESSAGE };
  if (isControlEvent(value) || isLegacyInterimEvent(value) || isTranscriptSegmentEvent(value)) {
    return { ok: true, event: value };
  }
  return { ok: false, message: PUBLIC_PROTOCOL_ERROR_MESSAGE };
}

export function handleLectureStreamSocketData(
  data: unknown,
  handlers: {
    onEvent: (event: LectureStreamServerEvent) => void;
    onProtocolError: (message: string) => void;
  }
): boolean {
  const parsed = parseLectureStreamServerEvent(data);
  if (!parsed.ok) {
    handlers.onProtocolError(parsed.message);
    return false;
  }
  handlers.onEvent(parsed.event);
  return true;
}

export function shouldIgnoreLectureStreamEventAfterStop(
  event: LectureStreamServerEvent,
  stopRequested: boolean
): boolean {
  if (!stopRequested) return false;
  return event.type === "ready" ||
    event.type === "captureRequested" ||
    event.type === "readyForAudio" ||
    event.type === "providerAccepted";
}

export function resolveEndedEventOutcome(event: Extract<LectureStreamControlEvent, { type: "ended" }>):
  | "completed"
  | "flush-timeout" {
  return event.outcome;
}

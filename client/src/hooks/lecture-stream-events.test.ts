import { describe, expect, it, vi } from "vitest";
import type { TranscriptEvent as ServerTranscriptEvent } from "../../../server/src/types";
import {
  handleLectureStreamSocketData,
  MAX_TRANSCRIPT_EVENT_JSON_CHARS,
  parseLectureStreamServerEvent,
  resolveEndedEventOutcome,
  shouldIgnoreLectureStreamEventAfterStop
} from "./lecture-stream-events";

const SERVER_WIRE_EVENT_FIXTURES = [
  { type: "ready", message: "데모 준비" },
  { type: "captureRequested", message: "마이크 권한 확인" },
  { type: "readyForAudio", message: "오디오 전송 가능" },
  { type: "providerAccepted", message: "AWS 연결 승인" },
  { type: "status", message: "연결 중" },
  { type: "error", message: "음성인식 오류" },
  {
    type: "partial",
    segmentId: "server-partial",
    providerResultId: "provider-partial",
    revision: 1,
    text: "확정 전 자막",
    stablePrefixLength: 3,
    startTimeMs: 0,
    endTimeMs: 400
  },
  {
    type: "final",
    segmentId: "server-final",
    providerResultId: "provider-final",
    revision: 2,
    text: "RAG 확정 자막",
    rawText: "레그 확정 자막",
    detectedTerms: ["rag"],
    relatedPage: 2,
    corrections: [{
      originalText: "레그",
      correctedText: "RAG",
      termId: "rag",
      displayStart: 0,
      displayEnd: 3,
      reason: "spokenAlias"
    }],
    startTimeMs: 0,
    endTimeMs: 900
  },
  { type: "ended", outcome: "completed", message: "종료 완료" },
  { type: "ended", outcome: "flush-timeout", message: "확정 대기 초과" }
] satisfies ServerTranscriptEvent[];

describe("lecture stream WebSocket event validation", () => {
  it.each(SERVER_WIRE_EVENT_FIXTURES)(
    "accepts the server contract fixture $type",
    (event) => {
      expect(parseLectureStreamServerEvent(JSON.stringify(event))).toEqual({ ok: true, event });
    }
  );

  it("accepts a fully described final segment without stripping correction evidence", () => {
    const event = {
      type: "final",
      segmentId: "segment-1",
      providerResultId: "provider-1",
      revision: 3,
      text: "RAG를 설명합니다.",
      rawText: "레그를 설명합니다.",
      detectedTerms: ["rag"],
      relatedPage: 2,
      corrections: [
        {
          originalText: "레그",
          correctedText: "RAG",
          termId: "rag",
          displayStart: 0,
          displayEnd: 3,
          reason: "spokenAlias"
        }
      ],
      startTimeMs: 100,
      endTimeMs: 900
    };

    expect(parseLectureStreamServerEvent(JSON.stringify(event))).toEqual({ ok: true, event });
  });

  it.each([
    ["invalid JSON", "{"],
    ["binary payload", new ArrayBuffer(8)],
    ["unknown event", JSON.stringify({ type: "surprise" })],
    ["missing segment identity", JSON.stringify({ type: "partial", revision: 1, text: "자막" })],
    ["wrong revision type", JSON.stringify({ type: "final", segmentId: "a", revision: "2", text: "자막" })],
    ["invalid correction range", JSON.stringify({
      type: "final",
      segmentId: "a",
      revision: 2,
      text: "RAG",
      corrections: [{
        originalText: "레그",
        correctedText: "RAG",
        termId: "rag",
        displayStart: 0,
        displayEnd: 99,
        reason: "spokenAlias"
      }]
    })],
    ["oversized payload", "x".repeat(MAX_TRANSCRIPT_EVENT_JSON_CHARS + 1)]
  ])("rejects %s with one public protocol error", (_label, payload) => {
    const onEvent = vi.fn();
    const onProtocolError = vi.fn();

    expect(handleLectureStreamSocketData(payload, { onEvent, onProtocolError })).toBe(false);
    expect(onEvent).not.toHaveBeenCalled();
    expect(onProtocolError).toHaveBeenCalledOnce();
    expect(onProtocolError).toHaveBeenCalledWith(
      "서버가 올바르지 않은 자막 데이터를 보냈습니다. 강연을 다시 시작해 주세요."
    );
  });

  it("routes a valid event exactly once", () => {
    const onEvent = vi.fn();
    const onProtocolError = vi.fn();
    const payload = JSON.stringify({ type: "readyForAudio", message: "오디오 전송 가능" });

    expect(handleLectureStreamSocketData(payload, { onEvent, onProtocolError })).toBe(true);
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith({ type: "readyForAudio", message: "오디오 전송 가능" });
    expect(onProtocolError).not.toHaveBeenCalled();
  });

  it("accepts the explicit microphone capture request", () => {
    const onEvent = vi.fn();
    const onProtocolError = vi.fn();
    const payload = JSON.stringify({ type: "captureRequested", message: "마이크 권한 확인" });

    expect(handleLectureStreamSocketData(payload, { onEvent, onProtocolError })).toBe(true);
    expect(onEvent).toHaveBeenCalledWith({ type: "captureRequested", message: "마이크 권한 확인" });
    expect(onProtocolError).not.toHaveBeenCalled();
  });

  it("ignores only late readiness after stop while still accepting final and ended events", () => {
    expect(shouldIgnoreLectureStreamEventAfterStop({ type: "captureRequested" }, true)).toBe(true);
    expect(shouldIgnoreLectureStreamEventAfterStop({ type: "readyForAudio" }, true)).toBe(true);
    expect(shouldIgnoreLectureStreamEventAfterStop({ type: "providerAccepted" }, true)).toBe(true);
    expect(
      shouldIgnoreLectureStreamEventAfterStop(
        { type: "final", segmentId: "segment-1", revision: 2, text: "마지막 확정 자막" },
        true
      )
    ).toBe(false);
    expect(shouldIgnoreLectureStreamEventAfterStop({ type: "ended", outcome: "completed" }, true)).toBe(false);
    expect(shouldIgnoreLectureStreamEventAfterStop({ type: "ready" }, false)).toBe(false);
  });

  it("requires and uses the typed ended outcome", () => {
    expect(resolveEndedEventOutcome({ type: "ended", outcome: "completed" })).toBe("completed");
    expect(resolveEndedEventOutcome({ type: "ended", outcome: "flush-timeout" })).toBe("flush-timeout");
    expect(parseLectureStreamServerEvent(JSON.stringify({ type: "ended", message: "종료" })).ok).toBe(false);
  });

  it("rejects fields that violate the shared control and partial-event contract", () => {
    expect(parseLectureStreamServerEvent(JSON.stringify({
      type: "readyForAudio",
      outcome: "completed"
    })).ok).toBe(false);
    expect(parseLectureStreamServerEvent(JSON.stringify({
      type: "partial",
      segmentId: "partial-with-final-data",
      revision: 1,
      text: "확정 전",
      rawText: "금지된 원문"
    })).ok).toBe(false);
  });
});

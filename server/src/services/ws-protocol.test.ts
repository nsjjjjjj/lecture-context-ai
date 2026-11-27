import { describe, expect, it } from "vitest";
import {
  AWS_PCM_MAX_CHUNK_BYTES,
  parseClientControlMessage,
  validateAwsPcmAudioChunk,
  WebSocketProtocolError
} from "./ws-protocol.js";

describe("WebSocket client protocol boundary", () => {
  it("accepts only strict start and stop control messages", () => {
    expect(parseClientControlMessage(Buffer.from(JSON.stringify({
      type: "start",
      mode: "live",
      terms: [],
      phraseSet: []
    })))).toMatchObject({ type: "start", mode: "live" });
    expect(parseClientControlMessage(Buffer.from('{"type":"stop"}'))).toEqual({ type: "stop" });
    expect(parseClientControlMessage(Buffer.from('{"type":"captureReady"}'))).toEqual({ type: "captureReady" });

    expect(() => parseClientControlMessage(Buffer.from('{"type":"pause"}'))).toThrow(WebSocketProtocolError);
    expect(() => parseClientControlMessage(Buffer.from('{"type":"stop","extra":true}'))).toThrow(
      WebSocketProtocolError
    );
    expect(() => parseClientControlMessage(Buffer.from('{"type":"captureReady","extra":true}'))).toThrow(
      WebSocketProtocolError
    );
    expect(() => parseClientControlMessage(Buffer.from("not-json"))).toThrow("올바른 JSON");
  });

  it("accepts only non-empty even-sized PCM chunks of at most 200ms", () => {
    expect(validateAwsPcmAudioChunk(Buffer.alloc(3_200))).toHaveLength(3_200);
    expect(validateAwsPcmAudioChunk(Buffer.alloc(AWS_PCM_MAX_CHUNK_BYTES))).toHaveLength(
      AWS_PCM_MAX_CHUNK_BYTES
    );
    expect(() => validateAwsPcmAudioChunk(Buffer.alloc(0))).toThrow("빈 오디오");
    expect(() => validateAwsPcmAudioChunk(Buffer.alloc(3))).toThrow("완전한 샘플");
    expect(() => validateAwsPcmAudioChunk(Buffer.alloc(AWS_PCM_MAX_CHUNK_BYTES + 2))).toThrow("최대 200ms");
  });
});

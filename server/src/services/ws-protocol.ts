import { z } from "zod";
import type { StartMessage } from "../types.js";
import { MAX_GLOSSARY_TERMS, MAX_PHRASE_SET_FORMS } from "./phrase-set-limits.js";

export const WS_MAX_PAYLOAD_BYTES = 256 * 1_024;
export const AWS_PCM_MAX_CHUNK_MS = 200;
export const AWS_PCM_MAX_CHUNK_BYTES = (16_000 * 2 * AWS_PCM_MAX_CHUNK_MS) / 1_000;

const rawStartMessageSchema = z.object({
  type: z.literal("start"),
  mode: z.enum(["live", "demo"]),
  terms: z.array(z.unknown()).max(MAX_GLOSSARY_TERMS * 4),
  phraseSet: z.array(z.unknown()).max(MAX_PHRASE_SET_FORMS * 4),
  vocabularyName: z.string().max(200).optional()
}).strict();

const stopMessageSchema = z.object({ type: z.literal("stop") }).strict();
const captureReadyMessageSchema = z.object({ type: z.literal("captureReady") }).strict();
const clientControlMessageSchema = z.discriminatedUnion("type", [
  rawStartMessageSchema,
  captureReadyMessageSchema,
  stopMessageSchema
]);

export type ClientControlMessage =
  | Pick<StartMessage, "type" | "mode"> & {
      terms: unknown[];
      phraseSet: unknown[];
      vocabularyName?: string;
    }
  | { type: "captureReady" }
  | { type: "stop" };

export class WebSocketProtocolError extends Error {
  readonly closeCode: number;

  constructor(message: string, closeCode = 1008) {
    super(message);
    this.name = "WebSocketProtocolError";
    this.closeCode = closeCode;
  }
}

export function rawWebSocketDataToBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export function parseClientControlMessage(data: Buffer | ArrayBuffer | Buffer[]): ClientControlMessage {
  const payload = rawWebSocketDataToBuffer(data);
  if (payload.byteLength > WS_MAX_PAYLOAD_BYTES) {
    throw new WebSocketProtocolError("요청 메시지가 허용 크기를 초과했습니다.", 1009);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new WebSocketProtocolError("요청 메시지는 올바른 JSON이어야 합니다.");
  }

  const result = clientControlMessageSchema.safeParse(parsed);
  if (!result.success) throw new WebSocketProtocolError("지원하지 않거나 형식이 올바르지 않은 요청입니다.");
  return result.data;
}

export function validateAwsPcmAudioChunk(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  const audio = rawWebSocketDataToBuffer(data);
  if (audio.byteLength === 0) throw new WebSocketProtocolError("빈 오디오 조각은 전송할 수 없습니다.");
  if (audio.byteLength > AWS_PCM_MAX_CHUNK_BYTES) {
    throw new WebSocketProtocolError("오디오 조각은 최대 200ms 분량이어야 합니다.", 1009);
  }
  if (audio.byteLength % 2 !== 0) {
    throw new WebSocketProtocolError("오디오는 16비트 PCM의 완전한 샘플 단위여야 합니다.");
  }
  return audio;
}

import type { AudioStream } from "@aws-sdk/client-transcribe-streaming";
import type { AudioEnqueueResult } from "./stt-session.js";

export const AWS_PCM_BYTES_PER_SECOND = 16_000 * 1 * 2;
export const AWS_AUDIO_MAX_QUEUED_LAG_MS = 500;
export const AWS_AUDIO_MAX_QUEUED_BYTES =
  (AWS_PCM_BYTES_PER_SECOND * AWS_AUDIO_MAX_QUEUED_LAG_MS) / 1_000;
export const AWS_AUDIO_HIGH_WATERMARK_BYTES = AWS_AUDIO_MAX_QUEUED_BYTES * 0.8;
export const AWS_AUDIO_LOW_WATERMARK_BYTES = AWS_AUDIO_MAX_QUEUED_BYTES * 0.4;

type QueueWaiter = (value: IteratorResult<AudioStream>) => void;

export class AwsAudioQueueOverflowError extends Error {
  constructor() {
    super("AWS Transcribe 오디오 큐가 0.5초 안전 한도를 초과했습니다.");
    this.name = "AwsAudioQueueOverflowError";
  }
}

export type AwsAudioQueueOptions = {
  maxQueuedBytes?: number;
  highWatermarkBytes?: number;
  lowWatermarkBytes?: number;
  onFirstAudio?: () => void;
  onLowWatermark?: () => void;
  onOverflow?: (error: AwsAudioQueueOverflowError) => void;
};

export class AwsAudioQueue implements AsyncIterable<AudioStream> {
  private readonly queue: Buffer[] = [];
  private readonly maxQueuedBytes: number;
  private readonly highWatermarkBytes: number;
  private readonly lowWatermarkBytes: number;
  private readonly onFirstAudio?: () => void;
  private readonly onLowWatermark?: () => void;
  private readonly onOverflow?: (error: AwsAudioQueueOverflowError) => void;
  private waiter: QueueWaiter | null = null;
  private state: "open" | "finishing" | "aborted" = "open";
  private queuedBytes = 0;
  private firstAudioSeen = false;
  private backpressured = false;

  constructor(options: AwsAudioQueueOptions = {}) {
    this.maxQueuedBytes = options.maxQueuedBytes ?? AWS_AUDIO_MAX_QUEUED_BYTES;
    this.highWatermarkBytes = options.highWatermarkBytes ?? AWS_AUDIO_HIGH_WATERMARK_BYTES;
    this.lowWatermarkBytes = options.lowWatermarkBytes ?? AWS_AUDIO_LOW_WATERMARK_BYTES;
    if (
      this.lowWatermarkBytes < 0 ||
      this.highWatermarkBytes <= this.lowWatermarkBytes ||
      this.maxQueuedBytes < this.highWatermarkBytes
    ) {
      throw new Error("AWS 오디오 큐 watermark 설정이 올바르지 않습니다.");
    }
    this.onFirstAudio = options.onFirstAudio;
    this.onLowWatermark = options.onLowWatermark;
    this.onOverflow = options.onOverflow;
  }

  enqueue(audio: Buffer): AudioEnqueueResult {
    if (this.state !== "open") return "closed";
    if (!this.firstAudioSeen) {
      this.firstAudioSeen = true;
      this.onFirstAudio?.();
    }

    if (audio.byteLength > this.maxQueuedBytes || this.queuedBytes + audio.byteLength > this.maxQueuedBytes) {
      const error = new AwsAudioQueueOverflowError();
      this.abort();
      this.onOverflow?.(error);
      return "closed";
    }

    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter({ done: false, value: { AudioEvent: { AudioChunk: audio } } });
      return "accepted";
    }

    this.queue.push(audio);
    this.queuedBytes += audio.byteLength;
    if (this.queuedBytes >= this.highWatermarkBytes) {
      this.backpressured = true;
      return "backpressure";
    }
    return "accepted";
  }

  finish(): void {
    if (this.state !== "open") return;
    this.state = "finishing";
    this.settleFinishedWaiter();
  }

  abort(): void {
    if (this.state === "aborted") return;
    this.state = "aborted";
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.settleFinishedWaiter();
  }

  getQueuedBytes(): number {
    return this.queuedBytes;
  }

  private settleFinishedWaiter(): void {
    if (!this.waiter || (this.state === "finishing" && this.queue.length > 0)) return;
    const waiter = this.waiter;
    this.waiter = null;
    waiter({ done: true, value: undefined });
  }

  private shift(): Buffer | undefined {
    const audio = this.queue.shift();
    if (!audio) return undefined;
    this.queuedBytes -= audio.byteLength;
    if (this.backpressured && this.queuedBytes <= this.lowWatermarkBytes) {
      this.backpressured = false;
      this.onLowWatermark?.();
    }
    return audio;
  }

  [Symbol.asyncIterator](): AsyncIterator<AudioStream> {
    return {
      next: async () => {
        const audio = this.shift();
        if (audio) return { done: false, value: { AudioEvent: { AudioChunk: audio } } };
        if (this.state !== "open") return { done: true, value: undefined };
        if (this.waiter) throw new Error("AWS 오디오 큐는 소비자 하나만 지원합니다.");
        return new Promise<IteratorResult<AudioStream>>((resolve) => {
          this.waiter = resolve;
        });
      }
    };
  }
}

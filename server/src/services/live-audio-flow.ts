import type { AudioEnqueueResult } from "./stt-session.js";

export const DEFAULT_GRPC_BACKPRESSURE_TIMEOUT_MS = 1_000;
export const LIVE_PCM_BYTES_PER_SECOND = 16_000 * 1 * 2;
export const LIVE_AUDIO_MAX_QUEUED_LAG_MS = 500;
export const LIVE_AUDIO_MAX_QUEUED_BYTES =
  (LIVE_PCM_BYTES_PER_SECOND * LIVE_AUDIO_MAX_QUEUED_LAG_MS) / 1_000;

type TimeoutHandle = ReturnType<typeof setTimeout>;

export type LiveAudioFlowController = {
  writeOrQueue: (audio: Buffer) => "written" | "queued" | "overflow" | "closed";
  resumeFromGrpc: () => void;
  flushBeforeFinishInput: () => Promise<"flushed" | "closed" | "disposed">;
  dispose: () => void;
  isPaused: () => boolean;
};

export function createLiveAudioFlowController(options: {
  enqueueAudio: (audio: Buffer) => AudioEnqueueResult;
  pauseInput: () => void;
  resumeInput: () => void;
  onTimeout: () => void;
  onOverflow: () => void;
  onClosed: () => void;
  timeoutMs?: number;
  maxQueuedBytes?: number;
  setTimer?: (callback: () => void, delayMs: number) => TimeoutHandle;
  clearTimer?: (handle: TimeoutHandle) => void;
}): LiveAudioFlowController {
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  const timeoutMs = options.timeoutMs ?? DEFAULT_GRPC_BACKPRESSURE_TIMEOUT_MS;
  const maxQueuedBytes = options.maxQueuedBytes ?? LIVE_AUDIO_MAX_QUEUED_BYTES;
  const queue: Buffer[] = [];
  let queuedBytes = 0;
  let paused = false;
  let timer: TimeoutHandle | null = null;
  let lifecycle: "accepting" | "flushing" | "disposed" = "accepting";
  let flushPromise: Promise<"flushed" | "closed" | "disposed"> | null = null;
  let resolveFlush: ((result: "flushed" | "closed" | "disposed") => void) | null = null;

  const clearPendingTimer = (): void => {
    if (!timer) return;
    clearTimer(timer);
    timer = null;
  };
  const settleFlush = (result: "flushed" | "closed" | "disposed"): void => {
    const resolve = resolveFlush;
    resolveFlush = null;
    resolve?.(result);
  };
  const discardQueuedAudio = (): void => {
    queue.length = 0;
    queuedBytes = 0;
  };
  const handleClosedSession = (): void => {
    const wasPaused = paused;
    paused = false;
    clearPendingTimer();
    discardQueuedAudio();
    if (wasPaused) options.resumeInput();
    options.onClosed();
    settleFlush("closed");
  };
  const handleBackpressureTimeout = (): void => {
    if (!paused || lifecycle === "disposed") return;
    paused = false;
    timer = null;
    discardQueuedAudio();
    options.resumeInput();
    options.onTimeout();
    settleFlush("closed");
  };
  const armBackpressureTimeout = (): void => {
    clearPendingTimer();
    timer = setTimer(handleBackpressureTimeout, Math.max(0, timeoutMs));
    if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") timer.unref();
  };
  const pauseForGrpc = (): void => {
    if (paused) return;
    paused = true;
    options.pauseInput();
    armBackpressureTimeout();
  };

  return {
    writeOrQueue(audio) {
      if (lifecycle !== "accepting") return "closed";
      if (paused) {
        if (queuedBytes + audio.byteLength > maxQueuedBytes) {
          discardQueuedAudio();
          paused = false;
          clearPendingTimer();
          options.resumeInput();
          options.onOverflow();
          return "overflow";
        }
        queue.push(audio);
        queuedBytes += audio.byteLength;
        return "queued";
      }

      const result = options.enqueueAudio(audio);
      if (result === "closed") {
        handleClosedSession();
        return "closed";
      }
      if (result === "backpressure") pauseForGrpc();
      return "written";
    },
    resumeFromGrpc() {
      if (!paused || lifecycle === "disposed") return;
      clearPendingTimer();

      while (queue.length > 0) {
        const audio = queue.shift();
        if (!audio) break;
        queuedBytes -= audio.byteLength;
        const result = options.enqueueAudio(audio);
        if (result === "closed") {
          handleClosedSession();
          return;
        }
        if (result === "backpressure") {
          armBackpressureTimeout();
          return;
        }
      }

      paused = false;
      options.resumeInput();
      if (lifecycle === "flushing") settleFlush("flushed");
    },
    flushBeforeFinishInput() {
      if (lifecycle === "disposed") return Promise.resolve("disposed");
      if (flushPromise) return flushPromise;

      lifecycle = "flushing";
      flushPromise = new Promise((resolve) => {
        resolveFlush = resolve;
      });

      // A backpressured write has already been accepted by the provider queue.
      // Only frames held in this controller must be forwarded before finishInput.
      if (queue.length === 0) {
        const wasPaused = paused;
        paused = false;
        clearPendingTimer();
        if (wasPaused) options.resumeInput();
        settleFlush("flushed");
      }
      return flushPromise;
    },
    dispose() {
      if (lifecycle === "disposed") return;
      lifecycle = "disposed";
      paused = false;
      discardQueuedAudio();
      clearPendingTimer();
      settleFlush("disposed");
    },
    isPaused() {
      return paused;
    }
  };
}

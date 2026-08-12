export const DEFAULT_GRPC_BACKPRESSURE_TIMEOUT_MS = 1_000;
export const LIVE_PCM_BYTES_PER_SECOND = 16_000 * 1 * 2;
export const LIVE_AUDIO_MAX_QUEUED_LAG_MS = 500;
export const LIVE_AUDIO_MAX_QUEUED_BYTES =
  (LIVE_PCM_BYTES_PER_SECOND * LIVE_AUDIO_MAX_QUEUED_LAG_MS) / 1_000;

type TimeoutHandle = ReturnType<typeof setTimeout>;

export type LiveAudioFlowController = {
  writeOrQueue: (audio: Buffer) => "written" | "queued" | "overflow";
  resumeFromGrpc: () => void;
  dispose: () => void;
  isPaused: () => boolean;
};

export function createLiveAudioFlowController(options: {
  writeAudio: (audio: Buffer) => boolean;
  pauseInput: () => void;
  resumeInput: () => void;
  onTimeout: () => void;
  onOverflow: () => void;
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

  const clearPendingTimer = (): void => {
    if (!timer) return;
    clearTimer(timer);
    timer = null;
  };
  const pauseForGrpc = (): void => {
    if (paused) return;
    paused = true;
    options.pauseInput();
    timer = setTimer(() => {
      if (!paused) return;
      paused = false;
      timer = null;
      queue.length = 0;
      queuedBytes = 0;
      options.resumeInput();
      options.onTimeout();
    }, Math.max(0, timeoutMs));
    if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") timer.unref();
  };

  return {
    writeOrQueue(audio) {
      if (paused) {
        if (queuedBytes + audio.byteLength > maxQueuedBytes) {
          queue.length = 0;
          queuedBytes = 0;
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

      if (!options.writeAudio(audio)) pauseForGrpc();
      return "written";
    },
    resumeFromGrpc() {
      if (!paused) return;
      clearPendingTimer();

      while (queue.length > 0) {
        const audio = queue.shift();
        if (!audio) break;
        queuedBytes -= audio.byteLength;
        if (!options.writeAudio(audio)) {
          timer = setTimer(() => {
            if (!paused) return;
            paused = false;
            timer = null;
            queue.length = 0;
            queuedBytes = 0;
            options.resumeInput();
            options.onTimeout();
          }, Math.max(0, timeoutMs));
          if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") timer.unref();
          return;
        }
      }

      paused = false;
      options.resumeInput();
    },
    dispose() {
      paused = false;
      queue.length = 0;
      queuedBytes = 0;
      clearPendingTimer();
    },
    isPaused() {
      return paused;
    }
  };
}

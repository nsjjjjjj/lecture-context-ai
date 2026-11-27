export const LIVE_PCM_BYTES_PER_SECOND = 16_000 * 1 * 2;
export const LIVE_AUDIO_MAX_BUFFERED_LAG_MS = 500;
export const LIVE_AUDIO_MAX_BUFFERED_BYTES =
  (LIVE_PCM_BYTES_PER_SECOND * LIVE_AUDIO_MAX_BUFFERED_LAG_MS) / 1_000;

type LiveAudioSocket = Pick<WebSocket, "bufferedAmount" | "readyState" | "send">;

export type LiveAudioSendResult = "preparing" | "sent" | "unavailable" | "backpressure" | "send-error";
export type LiveAudioTransportResult = Exclude<LiveAudioSendResult, "preparing">;

export function sendLiveAudioChunk(
  socket: LiveAudioSocket,
  audio: ArrayBuffer,
  maxBufferedBytes = LIVE_AUDIO_MAX_BUFFERED_BYTES
): LiveAudioTransportResult {
  if (socket.readyState !== WebSocket.OPEN) return "unavailable";
  if (socket.bufferedAmount + audio.byteLength > maxBufferedBytes) return "backpressure";
  try {
    socket.send(audio);
    return "sent";
  } catch {
    return "send-error";
  }
}

export function forwardLiveAudioChunk(
  readyForAudio: boolean,
  socket: LiveAudioSocket,
  audio: ArrayBuffer,
  maxBufferedBytes = LIVE_AUDIO_MAX_BUFFERED_BYTES
): LiveAudioSendResult {
  if (!readyForAudio) return "preparing";
  return sendLiveAudioChunk(socket, audio, maxBufferedBytes);
}

export type PreReadyPcmQueue = {
  enqueue: (audio: ArrayBuffer) => "queued" | "overflow" | "closed";
  flush: (
    send: (audio: ArrayBuffer) => LiveAudioTransportResult
  ) => "flushed" | "unavailable" | "backpressure" | "send-error";
  clear: () => void;
  queuedBytes: () => number;
};

export function createPreReadyPcmQueue(
  maxQueuedBytes = LIVE_AUDIO_MAX_BUFFERED_BYTES
): PreReadyPcmQueue {
  const queue: ArrayBuffer[] = [];
  let bytes = 0;
  let open = true;

  const clear = (): void => {
    open = false;
    queue.length = 0;
    bytes = 0;
  };

  return {
    enqueue(audio) {
      if (!open) return "closed";
      if (bytes + audio.byteLength > maxQueuedBytes) return "overflow";
      queue.push(audio.slice(0));
      bytes += audio.byteLength;
      return "queued";
    },
    flush(send) {
      if (!open) return "unavailable";
      while (queue.length > 0) {
        const audio = queue.shift();
        if (!audio) break;
        bytes -= audio.byteLength;
        const result = send(audio);
        if (result !== "sent") {
          clear();
          return result;
        }
      }
      clear();
      return "flushed";
    },
    clear,
    queuedBytes: () => bytes
  };
}

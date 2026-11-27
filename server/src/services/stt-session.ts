export type AudioEnqueueResult = "accepted" | "backpressure" | "closed";

/**
 * Provider-neutral lifecycle for a single streaming transcription session.
 *
 * `finishInput` closes only the audio input so the adapter can keep reading
 * delayed final transcript events. `abort` is reserved for failures and
 * disconnected clients where no drain is expected.
 */
export type SttSession = {
  enqueueAudio: (audio: Buffer) => AudioEnqueueResult;
  finishInput: () => void;
  abort: (reason?: Error) => void;
};

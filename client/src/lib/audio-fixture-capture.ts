import { PcmRecorder } from "./pcm-recorder";
import { encodePcm16Wav } from "./wav";

export type PcmRecorderPort = Pick<PcmRecorder, "start" | "stop">;
export const MAX_FIXTURE_PCM_BYTES = 3_840_000;

export type CapturedAudioFixture = {
  wav: ArrayBuffer;
  dataBytes: number;
  durationMs: number;
};

type CaptureSession = {
  id: number;
  recorder: PcmRecorderPort;
  chunks: ArrayBuffer[];
  dataBytes: number;
  stopping: boolean;
  stopPromise: Promise<CapturedAudioFixture> | null;
  limitSettled: boolean;
  settleLimit: (reached: boolean) => void;
};

export type AudioFixtureCaptureSession = {
  id: number;
  limitReached: Promise<boolean>;
};

export class AudioFixtureCapture {
  private generation = 0;
  private owner: CaptureSession | null = null;

  constructor(private readonly createRecorder: () => PcmRecorderPort = () => new PcmRecorder()) {}

  async start(): Promise<AudioFixtureCaptureSession | null> {
    if (this.owner) throw new Error("이미 녹음 중입니다.");
    let resolveLimit!: (reached: boolean) => void;
    const limitReached = new Promise<boolean>((resolve) => { resolveLimit = resolve; });
    const session: CaptureSession = {
      id: ++this.generation,
      recorder: this.createRecorder(),
      chunks: [],
      dataBytes: 0,
      stopping: false,
      stopPromise: null,
      limitSettled: false,
      settleLimit: (reached) => {
        if (session.limitSettled) return;
        session.limitSettled = true;
        resolveLimit(reached);
      }
    };
    this.owner = session;
    try {
      await session.recorder.start((chunk) => {
        if (this.owner !== session || session.stopping) return;
        const evenSourceBytes = chunk.byteLength - (chunk.byteLength % 2);
        const remainingBytes = MAX_FIXTURE_PCM_BYTES - session.dataBytes;
        const acceptedBytes = Math.min(evenSourceBytes, remainingBytes);
        if (acceptedBytes > 0) {
          session.chunks.push(chunk.slice(0, acceptedBytes));
          session.dataBytes += acceptedBytes;
        }
        if (session.dataBytes >= MAX_FIXTURE_PCM_BYTES) session.settleLimit(true);
      });
      if (this.owner !== session) {
        session.settleLimit(false);
        await session.recorder.stop().catch(() => undefined);
        return null;
      }
      return { id: session.id, limitReached };
    } catch (error) {
      if (this.owner === session) this.owner = null;
      session.settleLimit(false);
      await session.recorder.stop().catch(() => undefined);
      throw error;
    }
  }

  stop(sessionId: number): Promise<CapturedAudioFixture | null> {
    const session = this.owner;
    if (!session || session.id !== sessionId) return Promise.resolve(null);
    if (session.stopPromise) return session.stopPromise;
    session.stopping = true;
    session.settleLimit(false);
    session.stopPromise = (async () => {
      try {
        await session.recorder.stop();
        return encodePcm16Wav(session.chunks);
      } finally {
        if (this.owner === session) this.owner = null;
      }
    })();
    return session.stopPromise;
  }

  async dispose(): Promise<void> {
    this.generation += 1;
    const session = this.owner;
    this.owner = null;
    if (!session) return;
    session.stopping = true;
    session.settleLimit(false);
    if (session.stopPromise) {
      await session.stopPromise.catch(() => undefined);
      return;
    }
    await session.recorder.stop().catch(() => undefined);
  }
}

export type LiveClientDiagnosticStage =
  | "websocket-open"
  | "recorder-running"
  | "first-pcm"
  | "provider-ready"
  | "first-interim"
  | "first-final"
  | "transport-failed"
  | "session-stop";

export type LiveClientDiagnosticRecord = {
  sessionId: string;
  stage: LiveClientDiagnosticStage;
  elapsedMs: number;
  pcmChunkCount: number;
  pcmBytes: number;
  maxInterchunkGapMs: number;
  maxWebSocketBufferedAmount: number;
};

export type LiveClientDiagnostics = {
  mark: (stage: LiveClientDiagnosticStage) => void;
  recordPcm: (byteLength: number, webSocketBufferedAmount: number) => void;
};

export function createDevelopmentLiveClientDiagnostics(
  development: boolean,
  options: {
    sessionId: string;
    now: () => number;
    reporter: (record: LiveClientDiagnosticRecord) => void;
  }
): LiveClientDiagnostics | null {
  if (!development) return null;

  const startedAt = options.now();
  const reportedOnce = new Set<LiveClientDiagnosticStage>();
  let pcmChunkCount = 0;
  let pcmBytes = 0;
  let previousPcmAt: number | null = null;
  let maxInterchunkGapMs = 0;
  let maxWebSocketBufferedAmount = 0;

  const mark = (stage: LiveClientDiagnosticStage): void => {
    if (reportedOnce.has(stage)) return;
    reportedOnce.add(stage);
    options.reporter({
      sessionId: options.sessionId,
      stage,
      elapsedMs: Math.max(0, options.now() - startedAt),
      pcmChunkCount,
      pcmBytes,
      maxInterchunkGapMs,
      maxWebSocketBufferedAmount
    });
  };

  return {
    mark,
    recordPcm(byteLength, webSocketBufferedAmount) {
      const now = options.now();
      if (previousPcmAt !== null) maxInterchunkGapMs = Math.max(maxInterchunkGapMs, now - previousPcmAt);
      previousPcmAt = now;
      pcmChunkCount += 1;
      pcmBytes += byteLength;
      maxWebSocketBufferedAmount = Math.max(maxWebSocketBufferedAmount, webSocketBufferedAmount);
      mark("first-pcm");
    }
  };
}

export type CaptionTimingEventKind = "interim" | "final";

export type CaptionReceiveToAfterPaintEstimate = {
  sequenceId: number;
  eventKind: CaptionTimingEventKind;
  receivedAtMs: number;
  afterPaintEstimateAtMs: number;
  receiveToAfterPaintEstimateMs: number;
};

export type CaptionReceiveToAfterPaintEstimator = {
  markReceived: (eventKind: CaptionTimingEventKind) => number;
};

export function createCaptionReceiveToAfterPaintEstimator(options: {
  requestAnimationFrame: (callback: () => void) => void;
  scheduleAfterFrameTask: (callback: () => void) => void;
  now: () => number;
  reporter: (estimate: CaptionReceiveToAfterPaintEstimate) => void;
}): CaptionReceiveToAfterPaintEstimator {
  let sequenceId = 0;

  return {
    markReceived(eventKind) {
      const currentSequenceId = ++sequenceId;
      const receivedAtMs = options.now();

      options.requestAnimationFrame(() => {
        // rAF precedes a rendering opportunity; the following task is only an estimate.
        options.scheduleAfterFrameTask(() => {
          const afterPaintEstimateAtMs = options.now();
          options.reporter({
            sequenceId: currentSequenceId,
            eventKind,
            receivedAtMs,
            afterPaintEstimateAtMs,
            receiveToAfterPaintEstimateMs: Math.max(0, afterPaintEstimateAtMs - receivedAtMs)
          });
        });
      });

      return currentSequenceId;
    }
  };
}

export function createDevelopmentCaptionReceiveToAfterPaintEstimator(
  development: boolean,
  options: Parameters<typeof createCaptionReceiveToAfterPaintEstimator>[0]
): CaptionReceiveToAfterPaintEstimator | null {
  return development ? createCaptionReceiveToAfterPaintEstimator(options) : null;
}

export type SocketTransportFailureSource = "error" | "close";

export type SocketTransportFailureDisposition = {
  status: "error";
  message: string;
  completeStopGate: boolean;
};

export function resolveSocketTransportFailureDisposition(
  source: SocketTransportFailureSource,
  isWaitingForServerEnd: boolean
): SocketTransportFailureDisposition {
  return {
    status: "error",
    message: isWaitingForServerEnd
      ? "강연 종료 중 자막 연결이 끊어졌습니다. 마지막 자막이 모두 반영되지 않았을 수 있습니다."
      : source === "error"
        ? "서버에 연결하지 못했습니다."
        : "자막 연결이 예기치 않게 종료되었습니다.",
    completeStopGate: isWaitingForServerEnd
  };
}

export function handleSocketTransportFailure(options: {
  source: SocketTransportFailureSource;
  isWaitingForServerEnd: boolean;
  isCurrent: () => boolean;
  shutDown: () => void;
  dispatchError: (message: string) => void;
  completeStopGate: () => void;
}): boolean {
  if (!options.isCurrent()) return false;

  const disposition = resolveSocketTransportFailureDisposition(options.source, options.isWaitingForServerEnd);
  options.shutDown();
  options.dispatchError(disposition.message);
  if (disposition.completeStopGate) options.completeStopGate();
  return true;
}

export function resolveMissingLiveStopRequestDisposition(
  terminalEventAlreadyHandled: boolean
): SocketTransportFailureDisposition | null {
  if (terminalEventAlreadyHandled) return null;
  return {
    status: "error",
    message: "강연 종료 중 자막 연결이 끊어졌습니다. 마지막 자막이 모두 반영되지 않았을 수 있습니다.",
    completeStopGate: false
  };
}

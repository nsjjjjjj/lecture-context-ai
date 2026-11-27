import type { TranscriptEvent, TranscriptSegmentEvent } from "../types.js";

export const DEFAULT_OUTBOUND_HIGH_WATER_MARK_BYTES = 128 * 1_024;
export const DEFAULT_OUTBOUND_MAX_BUFFERED_BYTES = 1 * 1_024 * 1_024;
export const DEFAULT_OUTBOUND_MAX_QUEUED_BYTES = 256 * 1_024;
export const DEFAULT_OUTBOUND_DRAIN_TIMEOUT_MS = 2_000;

type OutboundTransport = {
  isOpen: () => boolean;
  bufferedAmount: () => number;
  send: (payload: string, callback: (error?: Error) => void) => void;
  close: (code: number, reason: string) => void;
  terminate: () => void;
};

type QueueItem = {
  event: TranscriptEvent;
  payload: string;
  bytes: number;
};

export type OutboundWebSocketFlowOptions = {
  transport: OutboundTransport;
  highWaterMarkBytes?: number;
  maxBufferedBytes?: number;
  maxQueuedBytes?: number;
  drainIntervalMs?: number;
  drainTimeoutMs?: number;
  overflowEvent: TranscriptEvent;
  onOverflow: () => void;
};

export type OutboundSendResult = "sent" | "queued" | "coalesced" | "closed" | "overflow";

export type OutboundWebSocketFlowController = {
  send: (event: TranscriptEvent) => OutboundSendResult;
  finish: (event: TranscriptEvent, code: number, reason: string) => OutboundSendResult;
  flushNow: () => void;
  queuedBytes: () => number;
  dispose: () => void;
};

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function isPartial(event: TranscriptEvent): event is TranscriptSegmentEvent & { type: "partial" } {
  return event.type === "partial";
}

function isFinal(event: TranscriptEvent): event is TranscriptSegmentEvent & { type: "final" } {
  return event.type === "final";
}

/**
 * Keeps application events ordered without allowing a slow browser to grow an
 * unbounded server-side queue. Only the newest tail partial for one segment is
 * replaceable; finals and terminal events are always treated as barriers.
 */
export function createOutboundWebSocketFlowController(
  options: OutboundWebSocketFlowOptions
): OutboundWebSocketFlowController {
  const highWaterMarkBytes = positiveInteger(
    options.highWaterMarkBytes,
    DEFAULT_OUTBOUND_HIGH_WATER_MARK_BYTES
  );
  const maxBufferedBytes = Math.max(
    highWaterMarkBytes,
    positiveInteger(options.maxBufferedBytes, DEFAULT_OUTBOUND_MAX_BUFFERED_BYTES)
  );
  const maxQueuedBytes = positiveInteger(options.maxQueuedBytes, DEFAULT_OUTBOUND_MAX_QUEUED_BYTES);
  const drainIntervalMs = positiveInteger(options.drainIntervalMs, 10);
  const drainTimeoutMs = positiveInteger(options.drainTimeoutMs, DEFAULT_OUTBOUND_DRAIN_TIMEOUT_MS);
  const queue: QueueItem[] = [];
  let queuedByteCount = 0;
  let drainTimer: NodeJS.Timeout | null = null;
  let terminalTimer: NodeJS.Timeout | null = null;
  let terminalClose: { code: number; reason: string; item: QueueItem } | null = null;
  let disposed = false;
  let overflowed = false;

  const clearTimers = (): void => {
    if (drainTimer) clearTimeout(drainTimer);
    if (terminalTimer) clearTimeout(terminalTimer);
    drainTimer = null;
    terminalTimer = null;
  };

  const closeTransport = (code: number, reason: string): void => {
    if (options.transport.isOpen()) options.transport.close(code, reason.slice(0, 123));
  };

  const overflow = (): OutboundSendResult => {
    if (overflowed || disposed) return "overflow";
    overflowed = true;
    clearTimers();
    queue.length = 0;
    queuedByteCount = 0;
    options.onOverflow();

    if (!options.transport.isOpen()) return "overflow";
    const payload = JSON.stringify(options.overflowEvent);
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      closeTransport(1013, "outbound flow overflow");
    };
    try {
      options.transport.send(payload, finish);
    } catch {
      settled = true;
      options.transport.terminate();
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      options.transport.terminate();
    }, Math.min(drainTimeoutMs, 250));
    timer.unref();
    return "overflow";
  };

  const scheduleDrain = (): void => {
    if (disposed || overflowed || drainTimer || queue.length === 0) return;
    drainTimer = setTimeout(() => {
      drainTimer = null;
      flushNow();
    }, drainIntervalMs);
    drainTimer.unref();
  };

  const dispatch = (item: QueueItem): void => {
    try {
      options.transport.send(item.payload, (error) => {
        if (error) {
          overflow();
          return;
        }
        if (terminalClose?.item === item) {
          const { code, reason } = terminalClose;
          terminalClose = null;
          clearTimers();
          closeTransport(code, reason);
        } else {
          flushNow();
        }
      });
    } catch {
      overflow();
    }
  };

  const flushNow = (): void => {
    if (disposed || overflowed || !options.transport.isOpen()) return;
    if (options.transport.bufferedAmount() > maxBufferedBytes) {
      overflow();
      return;
    }
    while (queue.length > 0 && options.transport.bufferedAmount() <= highWaterMarkBytes) {
      const item = queue.shift()!;
      queuedByteCount -= item.bytes;
      dispatch(item);
    }
    if (queue.length > 0) scheduleDrain();
  };

  const queueItem = (item: QueueItem): OutboundSendResult => {
    const tail = queue.at(-1);
    if (isPartial(item.event) && tail && isPartial(tail.event) && tail.event.segmentId === item.event.segmentId) {
      if (item.event.revision <= tail.event.revision) return "coalesced";
      const replacementBytes = queuedByteCount - tail.bytes + item.bytes;
      if (replacementBytes > maxQueuedBytes) return overflow();
      queue[queue.length - 1] = item;
      queuedByteCount = replacementBytes;
      scheduleDrain();
      return "coalesced";
    }

    // A final supersedes only the immediately preceding partial for the same
    // segment. Crossing any other event would change observable event order.
    if (isFinal(item.event) && tail && isPartial(tail.event) && tail.event.segmentId === item.event.segmentId) {
      queue.pop();
      queuedByteCount -= tail.bytes;
    }

    if (queuedByteCount + item.bytes > maxQueuedBytes) return overflow();
    queue.push(item);
    queuedByteCount += item.bytes;
    scheduleDrain();
    return "queued";
  };

  const send = (event: TranscriptEvent): OutboundSendResult => {
    if (disposed || overflowed || terminalClose || !options.transport.isOpen()) return "closed";
    if (options.transport.bufferedAmount() > maxBufferedBytes) return overflow();
    const payload = JSON.stringify(event);
    const item = { event, payload, bytes: Buffer.byteLength(payload, "utf8") };
    if (queue.length === 0 && options.transport.bufferedAmount() <= highWaterMarkBytes) {
      dispatch(item);
      return "sent";
    }
    return queueItem(item);
  };

  const finish = (event: TranscriptEvent, code: number, reason: string): OutboundSendResult => {
    if (disposed || overflowed || terminalClose || !options.transport.isOpen()) return "closed";
    if (options.transport.bufferedAmount() > maxBufferedBytes) return overflow();
    const payload = JSON.stringify(event);
    const item = { event, payload, bytes: Buffer.byteLength(payload, "utf8") };
    terminalClose = { code, reason: reason.slice(0, 123), item };
    terminalTimer = setTimeout(() => overflow(), drainTimeoutMs);
    terminalTimer.unref();
    const result = queue.length === 0 && options.transport.bufferedAmount() <= highWaterMarkBytes
      ? (dispatch(item), "sent" as const)
      : queueItem(item);
    if (result === "overflow") return result;
    return result;
  };

  return {
    send,
    finish,
    flushNow,
    queuedBytes: () => queuedByteCount,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimers();
      queue.length = 0;
      queuedByteCount = 0;
      terminalClose = null;
    }
  };
}

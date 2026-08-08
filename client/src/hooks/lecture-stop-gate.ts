export const LIVE_STOP_TIMEOUT_MS = 7_000;

type PendingStop = {
  socket: WebSocket;
  promise: Promise<void>;
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
};

export type LiveStopGate = {
  wait: (socket: WebSocket, onTimeout: () => void | Promise<void>) => Promise<void>;
  complete: (socket: WebSocket) => boolean;
  cancel: (socket?: WebSocket) => boolean;
  isWaiting: (socket: WebSocket) => boolean;
};

export function createLiveStopGate(timeoutMs = LIVE_STOP_TIMEOUT_MS): LiveStopGate {
  let pending: PendingStop | null = null;

  const settle = (socket?: WebSocket): boolean => {
    if (!pending || (socket && pending.socket !== socket)) return false;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    current.resolve();
    return true;
  };

  return {
    wait(socket, onTimeout) {
      if (pending?.socket === socket) return pending.promise;
      settle();

      let resolve: () => void = () => undefined;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      const timer = setTimeout(() => {
        if (!pending || pending.socket !== socket) return;
        pending = null;
        void Promise.resolve()
          .then(onTimeout)
          .finally(resolve);
      }, Math.max(0, timeoutMs));
      pending = { socket, promise, resolve, timer };
      return promise;
    },
    complete: settle,
    cancel: settle,
    isWaiting(socket) {
      return pending?.socket === socket;
    }
  };
}

export const LIVE_CAPTURE_PERMISSION_TIMEOUT_MS = 30_000;
export const LIVE_FIRST_PCM_TIMEOUT_MS = 3_000;
export const LIVE_SOCKET_OPEN_TIMEOUT_MS = 5_000;
export const LIVE_START_HANDSHAKE_TIMEOUT_MS = 12_000;

export type LectureSessionDeadlineKind =
  | "socket-open"
  | "start-handshake"
  | "capture-permission"
  | "first-pcm";

type LectureSessionDeadline = {
  owner: object;
  generation: number;
  timer: ReturnType<typeof setTimeout>;
};

export type LectureSessionDeadlineController = {
  arm: (
    kind: LectureSessionDeadlineKind,
    owner: object,
    generation: number,
    timeoutMs: number,
    onTimeout: () => void
  ) => void;
  clear: (kind: LectureSessionDeadlineKind, owner?: object, generation?: number) => boolean;
  clearSession: (owner: object, generation?: number) => number;
  clearAll: () => number;
};

export function createLectureSessionDeadlineController(
  dependencies: {
    setTimer?: (callback: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  } = {}
): LectureSessionDeadlineController {
  const setTimer = dependencies.setTimer ?? ((callback, timeoutMs) => globalThis.setTimeout(callback, timeoutMs));
  const clearTimer = dependencies.clearTimer ?? ((timer) => globalThis.clearTimeout(timer));
  const deadlines = new Map<LectureSessionDeadlineKind, LectureSessionDeadline>();

  const clear = (kind: LectureSessionDeadlineKind, owner?: object, generation?: number): boolean => {
    const deadline = deadlines.get(kind);
    if (
      !deadline ||
      (owner !== undefined && deadline.owner !== owner) ||
      (generation !== undefined && deadline.generation !== generation)
    ) {
      return false;
    }
    deadlines.delete(kind);
    clearTimer(deadline.timer);
    return true;
  };

  return {
    arm(kind, owner, generation, timeoutMs, onTimeout) {
      clear(kind);
      const deadline: LectureSessionDeadline = {
        owner,
        generation,
        timer: setTimer(() => {
          if (deadlines.get(kind) !== deadline) return;
          deadlines.delete(kind);
          onTimeout();
        }, Math.max(0, timeoutMs))
      };
      deadlines.set(kind, deadline);
    },
    clear,
    clearSession(owner, generation) {
      let cleared = 0;
      for (const kind of deadlines.keys()) {
        if (clear(kind, owner, generation)) cleared += 1;
      }
      return cleared;
    },
    clearAll() {
      let cleared = 0;
      for (const kind of deadlines.keys()) {
        if (clear(kind)) cleared += 1;
      }
      return cleared;
    }
  };
}

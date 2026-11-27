import { useCallback, useRef, useState } from "react";

/**
 * Prevents a second UI action from entering while the first async action is
 * still active. The ref closes the same-render double-click gap; state is only
 * the presentation layer used to disable conflicting controls.
 */
export function useExclusiveActionGate() {
  const activeRef = useRef(false);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async <T,>(action: () => T | Promise<T>): Promise<T | undefined> => {
    if (activeRef.current) return undefined;
    activeRef.current = true;
    setBusy(true);
    try {
      return await action();
    } finally {
      activeRef.current = false;
      setBusy(false);
    }
  }, []);

  return { busy, run } as const;
}

import { useCallback, useEffect, useRef } from "react";

interface PendingSave<T> {
  targetKey: string;
  value: T;
  persist: (value: T) => Promise<void> | void;
}

/**
 * Debounce an auto-save without letting a pending value cross a settings
 * target boundary. The callback is captured when the value is scheduled, so a
 * later render for another project cannot redirect the old write.
 */
export function useTargetedDebouncedSave<T>(
  targetKey: string,
  persist: (value: T) => Promise<void> | void,
  delay = 600,
) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<PendingSave<T> | null>(null);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const queued = pending.current;
    pending.current = null;
    if (queued) void queued.persist(queued.value);
  }, []);

  const schedule = useCallback(
    (value: T) => {
      if (pending.current && pending.current.targetKey !== targetKey) flush();
      pending.current = { targetKey, value, persist };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, delay);
    },
    [delay, flush, persist, targetKey],
  );

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    pending.current = null;
  }, []);

  // Changing scope/project and unmounting both flush the value to the callback
  // captured for its original target.
  useEffect(() => () => flush(), [flush, targetKey]);

  return { schedule, flush, cancel };
}

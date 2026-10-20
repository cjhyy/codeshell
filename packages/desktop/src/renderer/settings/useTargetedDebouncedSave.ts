import { useCallback, useEffect, useRef, useState } from "react";

interface PendingSave<T> {
  targetKey: string;
  value: T;
  persist: (value: T) => Promise<void> | void;
}

/**
 * Debounce an auto-save without letting a pending value cross a settings
 * target boundary. The callback is captured when the value is scheduled, so a
 * later render for another project cannot redirect the old write.
 *
 * A rejected write keeps its value queued for its original target (unless a
 * newer edit replaced it) and exposes the failure as `error`, so the next
 * blur/flush, a target switch or leaving the page retries it.
 */
export function useTargetedDebouncedSave<T>(
  targetKey: string,
  persist: (value: T) => Promise<void> | void,
  delay = 600,
) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<PendingSave<T> | null>(null);
  const mounted = useRef(true);
  const [error, setError] = useState<string | null>(null);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const queued = pending.current;
    pending.current = null;
    if (!queued) return;
    let saved: Promise<void> | void;
    try {
      saved = queued.persist(queued.value);
    } catch (cause) {
      saved = Promise.reject(cause);
    }
    void Promise.resolve(saved).then(
      () => {
        if (mounted.current) setError(null);
      },
      (cause: unknown) => {
        if (!pending.current) pending.current = queued;
        if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
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

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Changing scope/project and unmounting both flush the value to the callback
  // captured for its original target.
  useEffect(() => () => flush(), [flush, targetKey]);

  return { schedule, flush, cancel, error };
}

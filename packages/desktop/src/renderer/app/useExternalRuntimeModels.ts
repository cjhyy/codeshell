import { useEffect, useRef, useState } from "react";
import type { ExternalRuntimeModelEntry } from "../../shared/external-runtime-models";

const REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

/** Keep runtime choices current without delaying configured/native model loading. */
export function useExternalRuntimeModels(
  enabled: boolean,
  settingsRevision: number,
): ExternalRuntimeModelEntry[] {
  const [models, setModels] = useState<ExternalRuntimeModelEntry[]>([]);
  const inFlight = useRef<Promise<ExternalRuntimeModelEntry[]> | null>(null);

  useEffect(() => {
    if (!enabled) {
      setModels([]);
      return;
    }
    let cancelled = false;
    let refreshing: Promise<void> | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = (): Promise<void> => {
      if (cancelled) return Promise.resolve();
      if (refreshing) return refreshing;
      refreshing = (async () => {
        try {
          // A settings change can invalidate a request while IPC is still running.
          // Wait for it before issuing the new query, and never apply its old result.
          if (inFlight.current) await inFlight.current.catch(() => undefined);
          if (cancelled) return;
          const request = window.codeshell.externalRuntime.models();
          inFlight.current = request;
          try {
            const entries = await request;
            if (!cancelled) setModels(entries);
          } finally {
            if (inFlight.current === request) inFlight.current = null;
          }
        } catch {
          // Preserve the last usable list if the bridge is temporarily unavailable.
        }
      })().finally(() => {
        refreshing = null;
      });
      return refreshing;
    };
    const refreshIfVisible = (): void => {
      if (!document.hidden) void refresh();
    };
    const scheduleNextPoll = (): void => {
      if (cancelled) return;
      timer = setTimeout(async () => {
        if (!document.hidden) await refresh();
        scheduleNextPoll();
      }, REFRESH_INTERVAL_MS);
    };
    // Main caches for five minutes after discovery completes. Starting the next
    // timer after the response avoids hitting that cache just before it expires.
    // Focus and visibility checks leave this polling schedule unchanged.
    void refresh().then(scheduleNextPoll);
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [enabled, settingsRevision]);

  return enabled ? models : [];
}

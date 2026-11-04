/**
 * A stop of a Session's current run was requested, from any source (Desktop
 * window, paired phone, task inbox, external runtime). Listeners run BEFORE
 * the stop reaches the worker/provider, so Host-held follow-up turns can be
 * paused first instead of starting on the idle boundary the stop creates.
 * Stopping the current run never discards pending turns.
 */
type RunStopListener = (sessionId: string) => void;

const listeners = new Set<RunStopListener>();

export function onRunStopRequested(listener: RunStopListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyRunStopRequested(sessionId: string): void {
  for (const listener of listeners) {
    try {
      listener(sessionId);
    } catch {
      // Bookkeeping must never block the stop itself.
    }
  }
}

/** Inspect a JSON-RPC frame headed to the worker; `agent/cancel` is a stop. */
export function observeRunStopFrame(message: { method?: unknown; params?: unknown }): void {
  if (message.method !== "agent/cancel") return;
  const sessionId = (message.params as { sessionId?: unknown } | undefined)?.sessionId;
  if (typeof sessionId === "string" && sessionId) notifyRunStopRequested(sessionId);
}

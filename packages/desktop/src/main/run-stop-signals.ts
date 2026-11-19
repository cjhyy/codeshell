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
  // A stopped run is also an interrupted one.
  notifyRunInterrupted(sessionId);
}

/**
 * A Session's current run is being cut short, by a Stop or by an
 * interrupt-and-send. The latter is NOT a stop: the user's next message
 * follows at once, so pending turns and the Goal are kept and the stop
 * listeners above are not told. What the interrupted run was doing in the
 * world (driving the computer) must end either way; that is what listens here.
 */
const interruptListeners = new Set<RunStopListener>();

export function onRunInterrupted(listener: RunStopListener): () => void {
  interruptListeners.add(listener);
  return () => interruptListeners.delete(listener);
}

export function notifyRunInterrupted(sessionId: string): void {
  for (const listener of interruptListeners) {
    try {
      listener(sessionId);
    } catch {
      // Bookkeeping must never block the interrupt itself.
    }
  }
}

/** Inspect a JSON-RPC frame headed to the worker; `agent/cancel` is a stop. */
export function observeRunStopFrame(message: { method?: unknown; params?: unknown }): void {
  if (message.method !== "agent/cancel") return;
  const sessionId = (message.params as { sessionId?: unknown } | undefined)?.sessionId;
  if (typeof sessionId === "string" && sessionId) notifyRunStopRequested(sessionId);
}

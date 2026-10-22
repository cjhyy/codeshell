interface ExternalSessionState {
  sessionId: string;
  active: boolean;
}

type Listener = (state: ExternalSessionState) => void;

/** Recover current runtime ownership when a renderer subscribes after start(). */
export function subscribeExternalRuntimeSessionState(
  activeSessions: ReadonlySet<string>,
  listeners: Set<Listener>,
  listener: Listener,
): () => void {
  listeners.add(listener);
  for (const sessionId of activeSessions) listener({ sessionId, active: true });
  return () => {
    listeners.delete(listener);
  };
}

interface InvokeOnly {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

/**
 * The Stop button. Main owns which sessions run on an external runtime, so ask
 * it first: preload's in-memory set is empty after a renderer reload while the
 * Codex / Claude provider keeps running, and routing that Stop to the native
 * `agent/cancel` would leave it streaming. Only a session Main does not own
 * falls through to the worker.
 */
export async function cancelSessionRun(
  ipc: InvokeOnly,
  nativeCancel: (sessionId: string | undefined) => Promise<unknown>,
  sessionId: string | undefined,
  options?: { keepGoal?: boolean },
): Promise<unknown> {
  if (sessionId) {
    // `keepGoal` (interrupt-and-send) only matters there: the native Engine
    // never pauses a Goal on cancel.
    const reply = (await ipc.invoke("externalRuntime:interrupt", sessionId, {
      keepGoal: options?.keepGoal === true,
      ifOwned: true,
    })) as { handled?: unknown } | undefined;
    if (reply?.handled === true) return undefined;
  }
  return nativeCancel(sessionId);
}

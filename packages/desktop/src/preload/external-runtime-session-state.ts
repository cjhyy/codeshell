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

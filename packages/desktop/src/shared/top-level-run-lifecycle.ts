export interface TopLevelRunLifecycle {
  running: boolean;
  runId?: string;
  clientMessageId?: string;
}

/** Infer liveness from existing run identities, without altering replay history. */
export function reduceTopLevelRunLifecycle(
  state: TopLevelRunLifecycle,
  value: unknown,
): TopLevelRunLifecycle {
  if (!value || typeof value !== "object") return state;
  const event = value as Record<string, unknown>;
  if (event.agentId) return state;
  const runId = typeof event.runId === "string" ? event.runId : undefined;
  const clientMessageId =
    typeof event.clientMessageId === "string" ? event.clientMessageId : undefined;
  if (event.type === "session_started") return { running: true, runId, clientMessageId };
  if (
    event.type !== "stream_request_start" &&
    event.type !== "turn_complete" &&
    event.type !== "error"
  )
    return state;
  if (
    (state.runId && runId && state.runId !== runId) ||
    (state.clientMessageId && clientMessageId && state.clientMessageId !== clientMessageId)
  )
    return state;
  if (event.type === "stream_request_start") {
    // A request inside an already-closed identified run cannot reopen it.
    if (!state.running && (state.runId || state.clientMessageId)) return state;
    return {
      running: true,
      runId: state.runId ?? runId,
      clientMessageId: state.clientMessageId ?? clientMessageId,
    };
  }
  return { ...state, running: false };
}

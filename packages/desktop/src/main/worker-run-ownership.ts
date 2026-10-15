interface RunIdentity {
  runId?: string;
  clientMessageId?: string;
}

function topLevelEvent(value: unknown): (RunIdentity & { type?: string }) | undefined {
  if (!value || typeof value !== "object") return undefined;
  const event = value as Record<string, unknown>;
  if (event.agentId) return undefined;
  return {
    type: typeof event.type === "string" ? event.type : undefined,
    runId: typeof event.runId === "string" ? event.runId : undefined,
    clientMessageId: typeof event.clientMessageId === "string" ? event.clientMessageId : undefined,
  };
}

/** The running Sessions owned by the current stdio worker, independent of other producers. */
export class WorkerRunOwnership {
  private readonly running = new Map<string, RunIdentity & { pending?: boolean }>();

  beginWorker(): void {
    this.running.clear();
  }

  endWorker(): string[] {
    const sessionIds = this.sessionIds();
    this.running.clear();
    return sessionIds;
  }

  /** Admission can fail before session_started, so claim the submitted run first. */
  beginRun(sessionId: string, clientMessageId?: string): void {
    this.running.set(sessionId, { clientMessageId, pending: true });
  }

  observeWorker(sessionId: string, value: unknown): void {
    const event = topLevelEvent(value);
    if (!event) return;
    const current = this.running.get(sessionId);
    if (event.type === "session_started") {
      if (
        current?.pending &&
        current.clientMessageId &&
        event.clientMessageId &&
        current.clientMessageId !== event.clientMessageId
      )
        return;
      this.running.set(sessionId, {
        runId: event.runId,
        clientMessageId: event.clientMessageId ?? current?.clientMessageId,
      });
    } else if (event.type === "turn_complete" || event.type === "error") {
      if (
        current?.pending &&
        current.clientMessageId &&
        event.clientMessageId !== current.clientMessageId
      )
        return;
      if (
        current?.clientMessageId &&
        event.clientMessageId &&
        current.clientMessageId !== event.clientMessageId
      )
        return;
      if (current?.runId && event.runId && current.runId !== event.runId) return;
      this.running.delete(sessionId);
    }
  }

  /** A new Main/external run owns this Session even if its old worker is still alive. */
  observeExternal(sessionId: string, value: unknown): void {
    if (topLevelEvent(value)?.type === "session_started") this.running.delete(sessionId);
  }

  sessionIds(): string[] {
    return [...this.running.keys()];
  }
}

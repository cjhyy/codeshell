/**
 * Tracks currently pending core approval requests for mobile clients.
 *
 * Session snapshots intentionally contain only stream events. Approval requests
 * are stateful: keep the latest unresolved raw JSON-RPC request here and replay
 * it to a phone when that phone binds to the matching session.
 */
export class PendingMobileApprovals {
  private readonly bySession = new Map<string, Map<string, string>>();

  observeOutboundLine(line: string): void {
    let msg: { method?: unknown; params?: unknown };
    try {
      msg = JSON.parse(line) as { method?: unknown; params?: unknown };
    } catch {
      return;
    }

    if (msg.method === "agent/approvalRequest") {
      const params = msg.params as Record<string, unknown> | null;
      const sessionId = params?.sessionId;
      const requestId = params?.requestId;
      if (typeof sessionId !== "string" || !sessionId) return;
      if (typeof requestId !== "string" || !requestId) return;

      let pending = this.bySession.get(sessionId);
      if (!pending) {
        pending = new Map<string, string>();
        this.bySession.set(sessionId, pending);
      }
      pending.set(requestId, line);
      return;
    }

    if (msg.method === "agent/approvalResolved") {
      const params = msg.params as Record<string, unknown> | null;
      const requestId = params?.requestId;
      if (typeof requestId === "string" && requestId) this.resolve(requestId);
    }
  }

  resolve(requestId: string): void {
    for (const [sessionId, pending] of this.bySession) {
      pending.delete(requestId);
      if (pending.size === 0) this.bySession.delete(sessionId);
    }
  }

  replayLines(sessionId: string): string[] {
    return [...(this.bySession.get(sessionId)?.values() ?? [])];
  }

  forgetSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

/**
 * Tracks currently pending core approval requests for mobile clients.
 *
 * Session snapshots intentionally contain only stream events. Approval requests
 * are stateful: keep the latest unresolved raw JSON-RPC request here and replay
 * it to a phone when that phone binds to the matching session.
 */
export interface PendingMobileApprovalRoute {
  sessionId: string;
  requestId: string;
  connectionId?: string;
  generation?: number;
  expiresAt?: number;
}

export class PendingMobileApprovals {
  private readonly bySession = new Map<string, Map<string, string>>();
  private workerGeneration: number | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  /** Requests belong to the worker that can answer them, never its successor. */
  setWorkerState(generation: number, alive: boolean): void {
    if (!alive || this.workerGeneration !== generation) this.bySession.clear();
    this.workerGeneration = generation;
  }

  observeOutboundLine(line: string): void {
    let msg: { method?: unknown; params?: unknown };
    try {
      msg = JSON.parse(line) as { method?: unknown; params?: unknown };
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;

    if (msg.method === "agent/approvalRequest") {
      const params = msg.params as Record<string, unknown> | null;
      const sessionId = params?.sessionId;
      const requestId = params?.requestId;
      if (typeof sessionId !== "string" || !sessionId) return;
      if (typeof requestId !== "string" || !requestId) return;
      if (typeof params?.expiresAt === "number" && params.expiresAt <= this.now()) return;

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
      if (typeof requestId === "string" && requestId) this.resolve(requestId, params ?? {});
    }
  }

  resolve(requestId: string, route: Partial<PendingMobileApprovalRoute> = {}): void {
    for (const [sessionId, pending] of this.bySession) {
      if (route.sessionId !== undefined && route.sessionId !== sessionId) continue;
      const line = pending.get(requestId);
      if (!line) continue;
      const params = JSON.parse(line).params as PendingMobileApprovalRoute;
      if (
        (params.connectionId !== undefined || params.generation !== undefined) &&
        (route.sessionId !== sessionId ||
          route.connectionId !== params.connectionId ||
          route.generation !== params.generation)
      )
        continue;
      if (
        (route.connectionId !== undefined && route.connectionId !== params.connectionId) ||
        (route.generation !== undefined && route.generation !== params.generation)
      )
        continue;
      pending.delete(requestId);
      if (pending.size === 0) this.bySession.delete(sessionId);
    }
  }

  replayLines(sessionId: string): string[] {
    this.pruneExpired();
    return [...(this.bySession.get(sessionId)?.values() ?? [])];
  }

  /** The stored worker envelope, rather than a phone's mutable current session, owns routing. */
  find(sessionId: string, requestId: string): PendingMobileApprovalRoute | undefined {
    this.pruneExpired();
    const line = this.bySession.get(sessionId)?.get(requestId);
    if (!line) return undefined;
    const { connectionId, generation, expiresAt } = JSON.parse(line).params;
    return { sessionId, requestId, connectionId, generation, expiresAt };
  }

  /** The desktop has a queue across sessions; return only its current pending requests. */
  replayAllLines(): string[] {
    this.pruneExpired();
    return [...this.bySession.values()].flatMap((pending) => [...pending.values()]);
  }

  forgetSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [sessionId, pending] of this.bySession) {
      for (const [requestId, line] of pending) {
        const expiresAt = JSON.parse(line).params.expiresAt;
        if (typeof expiresAt === "number" && expiresAt <= now) pending.delete(requestId);
      }
      if (!pending.size) this.bySession.delete(sessionId);
    }
  }
}

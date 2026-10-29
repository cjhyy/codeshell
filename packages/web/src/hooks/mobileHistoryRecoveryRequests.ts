import type {
  MobileClientEvent,
  MobileServerEvent,
  OutputHistoryRecoveryAcceptance,
  OutputHistoryRecoveryPlan,
  OutputHistoryRecoveryResult,
} from "@cjhyy/code-shell-core";

type Result = OutputHistoryRecoveryPlan | OutputHistoryRecoveryResult;
type Identity = {
  sessionId?: string;
  roomId?: string;
  revision: number;
  generation: number;
  online: boolean;
};

/** Explicit UI reviews share a socket, but never inherit a different selection's authority. */
export class MobileHistoryRecoveryRequests {
  private serial = 0;
  private pending = new Map<
    string,
    {
      type: "session.outputRecovery.plan" | "session.outputRecovery.apply";
      identity: Identity;
      resolve(result: Result): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private readonly deps: {
      send(event: MobileClientEvent): boolean;
      current(): Identity;
      timeoutMs?: number;
    },
  ) {}
  cancel(): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Recovery selection changed"));
    }
    this.pending.clear();
  }
  private request(
    type: "session.outputRecovery.plan" | "session.outputRecovery.apply",
    sessionId: string,
    acceptance?: OutputHistoryRecoveryAcceptance,
  ): Promise<Result> {
    const identity = { ...this.deps.current() };
    if (!identity.online || identity.roomId || identity.sessionId !== sessionId)
      return Promise.reject(new Error("Recovery selection changed"));
    const requestId = `history-review-${++this.serial}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Recovery request expired"));
      }, this.deps.timeoutMs ?? 30_000);
      this.pending.set(requestId, { type, identity, resolve, reject, timer });
      const event: MobileClientEvent =
        type === "session.outputRecovery.plan"
          ? { type, sessionId, requestId }
          : { type, sessionId, requestId, planId: acceptance!.planId, acceptHistoricalGap: true };
      if (!this.deps.send(event)) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error("Recovery request was not sent"));
      }
    });
  }
  plan(sessionId: string): Promise<OutputHistoryRecoveryPlan> {
    return this.request(
      "session.outputRecovery.plan",
      sessionId,
    ) as Promise<OutputHistoryRecoveryPlan>;
  }
  apply(
    sessionId: string,
    acceptance: OutputHistoryRecoveryAcceptance,
  ): Promise<OutputHistoryRecoveryResult> {
    return this.request(
      "session.outputRecovery.apply",
      sessionId,
      acceptance,
    ) as Promise<OutputHistoryRecoveryResult>;
  }
  observe(event: MobileServerEvent): boolean {
    if (
      event.type !== "session.outputRecovery.plan" &&
      event.type !== "session.outputRecovery.apply"
    )
      return false;
    const pending = this.pending.get(event.requestId);
    if (!pending) return true;
    this.pending.delete(event.requestId);
    clearTimeout(pending.timer);
    const now = this.deps.current();
    if (
      event.type !== pending.type ||
      event.sessionId !== pending.identity.sessionId ||
      event.result.sessionId !== event.sessionId ||
      !now.online ||
      now.roomId ||
      now.sessionId !== pending.identity.sessionId ||
      now.revision !== pending.identity.revision ||
      now.generation !== pending.identity.generation
    )
      pending.reject(new Error("Recovery selection changed"));
    else pending.resolve(event.result);
    return true;
  }
}

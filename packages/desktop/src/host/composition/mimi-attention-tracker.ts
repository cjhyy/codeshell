import type { DesktopPendingDecision } from "../../main/pet/pet-state-aggregator.js";
import type {
  PetAttentionOptions,
  PetAttentionEvent,
  PetAttentionSnapshot,
  PetPeek,
} from "../../main/pet/pet-notice-types.js";
import type { AttentionReceipt } from "../../shared/mimi-attention.js";

function receiptKey(pending: DesktopPendingDecision): string {
  return `local-user\u0000${pending.agentSessionId}\u0000${pending.requestId}\u0000pending`;
}

/** The Host evaluates pending work from its own projection and claims each cue before exposing it. */
export class MimiAttentionTracker {
  private readonly listeners = new Set<(event: PetAttentionEvent) => void>();
  private readonly timers = new Map<string, unknown>();
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delay: number) => unknown;
  private readonly cancel: (timer: unknown) => void;
  private readonly graceMs: number;
  private readonly burstMs: number;
  private activeSessionId: string | null = null;
  private count = 0;
  private unsubscribe?: () => void;
  private burstTimer: unknown;
  private burst: DesktopPendingDecision[] = [];

  private readonly observed = new Set<string>();
  private readonly acknowledged = new Set<string>();
  private retry?: unknown;
  private epoch = 0;
  constructor(private readonly options: PetAttentionOptions) {
    this.now = options.now ?? Date.now;
    this.schedule = options.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
    this.cancel =
      options.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.graceMs = options.graceMs ?? 15_000;
    this.burstMs = options.burstMs ?? 2_000;
  }
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.options.source.subscribe(() => this.reconcile());
    this.reconcile();
  }

  stop(): void {
    ++this.epoch;
    this.observed.clear();
    this.acknowledged.clear();
    if (this.retry !== undefined) this.cancel(this.retry);
    this.retry = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const timer of this.timers.values()) this.cancel(timer);
    this.timers.clear();
    if (this.burstTimer !== undefined) this.cancel(this.burstTimer);
    this.burstTimer = undefined;
    this.burst = [];
  }

  subscribe(listener: (event: PetAttentionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): PetAttentionSnapshot {
    return { surfaceablePendingCount: this.count };
  }

  setActiveSession(sessionId: string | null): void {
    this.activeSessionId = sessionId;
  }

  markAcknowledged(keys: readonly string[]) {
    for (const key of keys) if (this.observed.has(key)) this.acknowledged.add(key);
  }

  reconcile(): void {
    const snapshot = this.options.source.getSnapshot();
    const pending = snapshot.pending.filter((entry) => entry.status === "pending");
    const liveKeys = new Set(pending.map(receiptKey));
    for (const key of this.observed)
      if (!liveKeys.has(key)) {
        this.observed.delete(key);
        this.acknowledged.delete(key);
      }
    const claims: AttentionReceipt[] = [];
    for (const [key, timer] of this.timers) {
      if (liveKeys.has(key)) continue;
      this.cancel(timer);
      this.timers.delete(key);
    }

    const now = this.now();
    for (const decision of pending) {
      const key = receiptKey(decision);
      const remaining = decision.createdAt + this.graceMs - now;
      if (remaining <= 0) {
        const timer = this.timers.get(key);
        if (timer !== undefined) this.cancel(timer);
        this.timers.delete(key);
        if (!this.observed.has(key)) {
          this.observed.add(key);
          claims.push({
            key,
            state:
              this.activeSessionId === decision.agentSessionId ? "suppressed-active" : "surfaced",
          });
        }
      } else if (!this.timers.has(key)) {
        this.timers.set(
          key,
          this.schedule(() => {
            this.timers.delete(key);
            this.reconcile();
          }, remaining),
        );
      }
    }

    for (let i = 0; i < claims.length; i += 1_000) void this.claim(claims.slice(i, i + 1_000));
    const nextCount = pending.filter((decision) => decision.createdAt + this.graceMs <= now).length;
    if (nextCount !== this.count) {
      this.count = nextCount;
      this.emit({ kind: "count", surfaceablePendingCount: nextCount });
    }
  }

  private async claim(rows: AttentionReceipt[]): Promise<void> {
    const epoch = this.epoch;
    try {
      const claimed = new Set(await this.options.claim(rows));
      if (epoch !== this.epoch || !this.unsubscribe) return;
      const show = new Set(
        rows
          .filter((row) => row.state === "surfaced" && claimed.has(row.key))
          .map((row) => row.key),
      );
      const pending = this.options.source
        .getSnapshot()
        .pending.filter(
          (decision) =>
            decision.status === "pending" &&
            decision.agentSessionId !== this.activeSessionId &&
            !this.acknowledged.has(receiptKey(decision)) &&
            show.has(receiptKey(decision)),
        );
      if (!pending.length) return;
      this.burst.push(...pending);
      if (this.burstTimer === undefined)
        this.burstTimer = this.schedule(() => this.flushBurst(), this.burstMs);
    } catch (error) {
      if (epoch !== this.epoch) return;
      for (const row of rows) this.observed.delete(row.key);
      this.options.report(error);
      if (this.retry === undefined)
        this.retry = this.schedule(() => {
          this.retry = undefined;
          this.reconcile();
        }, this.graceMs || 15_000);
    }
  }

  private flushBurst(): void {
    this.burstTimer = undefined;
    const keys = new Set(this.burst.splice(0).map(receiptKey));
    const snapshot = this.options.source.getSnapshot();
    const decisions = snapshot.pending.filter(
      (decision) =>
        decision.status === "pending" &&
        decision.agentSessionId !== this.activeSessionId &&
        !this.acknowledged.has(receiptKey(decision)) &&
        keys.has(receiptKey(decision)),
    );
    if (decisions.length === 0) return;
    const receiptKeys = decisions.map(receiptKey);
    const peek: PetPeek =
      decisions.length === 1
        ? {
            id: `pet-peek-${decisions[0]!.agentSessionId}-${decisions[0]!.requestId}`,
            title: decisions[0]!.title,
            detail: decisions[0]!.kind === "ask_user" ? "需要回答" : "等待工具审批",
            receiptKeys,
            action: {
              type: "open_session",
              target: {
                agentSessionId: decisions[0]!.agentSessionId,
                snapshotVersion: snapshot.version,
                generation: snapshot.generation,
                requestId: decisions[0]!.requestId,
                routeGeneration: decisions[0]!.routeGeneration,
              },
            },
          }
        : {
            id: `pet-peek-burst-${this.now()}`,
            title: `${decisions.length} 个 session 等你决定`,
            detail: "打开 Mimi 查看全部待决策",
            receiptKeys,
            action: { type: "open_pet_pending", count: decisions.length },
          };
    this.emit({ kind: "peek", peek });
  }

  private emit(event: PetAttentionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

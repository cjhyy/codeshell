import type {
  DesktopPendingDecision,
  DesktopPetProjectionEvent,
  DesktopPetProjectionSnapshot,
  PetNavigationRequest,
} from "./pet-state-aggregator.js";

export interface PetPeek {
  id: string;
  title: string;
  detail: string;
  receiptKeys: string[];
  action:
    | { type: "open_session"; target: PetNavigationRequest }
    | { type: "open_pet_pending"; count: number };
}

export type PetAttentionEvent =
  | { kind: "count"; surfaceablePendingCount: number }
  | { kind: "peek"; peek: PetPeek };

export interface PetAttentionSnapshot {
  surfaceablePendingCount: number;
}

interface PetAttentionOptions {
  source: {
    getSnapshot(): DesktopPetProjectionSnapshot;
    subscribe(listener: (event: DesktopPetProjectionEvent) => void): () => void;
  };
  receipts: { has(key: string): boolean; mark(key: string, state?: string): void };
  now?: () => number;
  setTimeout?: (callback: () => void, delay: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
  graceMs?: number;
  burstMs?: number;
}

function receiptKey(pending: DesktopPendingDecision): string {
  return `local-user\u0000${pending.agentSessionId}\u0000${pending.requestId}\u0000pending`;
}

export class PetAttentionPolicy {
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

  markReceipts(keys: readonly string[], state: "seen" | "dismissed"): void {
    for (const key of keys) this.options.receipts.mark(key, state);
  }

  reconcile(): void {
    const snapshot = this.options.source.getSnapshot();
    const pending = snapshot.pending.filter((entry) => entry.status === "pending");
    const liveKeys = new Set(pending.map(receiptKey));
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
        this.surface(snapshot, decision, key);
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

    const nextCount = pending.filter((decision) => decision.createdAt + this.graceMs <= now).length;
    if (nextCount !== this.count) {
      this.count = nextCount;
      this.emit({ kind: "count", surfaceablePendingCount: nextCount });
    }
  }

  private surface(
    _snapshot: DesktopPetProjectionSnapshot,
    decision: DesktopPendingDecision,
    key: string,
  ): void {
    if (this.options.receipts.has(key)) return;
    if (this.activeSessionId === decision.agentSessionId) {
      this.options.receipts.mark(key, "suppressed-active");
      return;
    }
    this.options.receipts.mark(key, "surfaced");
    this.burst.push(decision);
    if (this.burstTimer !== undefined) return;
    this.burstTimer = this.schedule(() => this.flushBurst(), this.burstMs);
  }

  private flushBurst(): void {
    this.burstTimer = undefined;
    const decisions = this.burst.splice(0);
    if (decisions.length === 0) return;
    const snapshot = this.options.source.getSnapshot();
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

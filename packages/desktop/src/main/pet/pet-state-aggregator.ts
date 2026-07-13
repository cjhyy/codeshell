import type {
  PendingDecisionProjection,
  PetProjectionDelta,
  PetProjectionSnapshotResult,
  PetSessionProjection,
} from "@cjhyy/code-shell-core";
import path from "node:path";
import type { DiskSessionMeta, ListDiskSessionsResult } from "../sessions-service.js";

export type DesktopPetWorkerState =
  | "active"
  | "reclaimed"
  | "disconnected"
  | "reconciling"
  | "unknown";

export interface DesktopPetSession {
  agentSessionId: string;
  title?: string;
  workspaceDisplayName?: string;
  runState: PetSessionProjection["runState"];
  phase?: PetSessionProjection["phase"];
  summary?: string;
  queueDepth: number;
  lastActivityAt: number;
  pendingDecisionCount: number;
  terminal?: PetSessionProjection["terminal"];
  freshness: {
    source: PetSessionProjection["freshness"]["source"];
    observedAt: number;
    workerState: DesktopPetWorkerState;
  };
}

export type DesktopPendingDecision = Omit<PendingDecisionProjection, "owner" | "coreSessionId">;

export interface DesktopPetProjectionSnapshot {
  version: number;
  generation: number;
  workerState: DesktopPetWorkerState;
  sessions: DesktopPetSession[];
  pending: DesktopPendingDecision[];
  observedAt: number;
}

export interface PetNavigationRequest {
  agentSessionId: string;
  snapshotVersion: number;
  generation: number;
  requestId?: string;
  routeGeneration?: number;
}

export interface PetNavigationTarget {
  uiSessionId: string;
  engineSessionId: string;
  projectPath: string | null;
  title: string;
  updatedAt: number;
  origin: DiskSessionMeta["origin"];
  status?: DiskSessionMeta["status"];
}

export type PetNavigationResult =
  | { status: "not-found" }
  | {
      status: "ok" | "stale";
      target: PetNavigationTarget;
      pendingStatus?: "pending" | "resolved";
    };

interface DesktopPetEventBase {
  version: number;
  generation: number;
  observedAt: number;
}

type DesktopPetProjectionEventInput =
  | { kind: "session-upsert"; session: DesktopPetSession }
  | { kind: "session-remove"; sessionId: string }
  | { kind: "pending-upsert"; pending: DesktopPendingDecision }
  | { kind: "pending-remove"; sessionId: string; requestId: string }
  | { kind: "worker-state"; state: DesktopPetWorkerState }
  | { kind: "reset" };

export type DesktopPetProjectionEvent = DesktopPetEventBase & DesktopPetProjectionEventInput;

export type AgentBridgePetEvent =
  | { kind: "delta"; delta: PetProjectionDelta }
  | { kind: "lifecycle"; state: "active" | "reclaimed" | "disconnected" };

export interface PetStateBridge {
  hasLiveWorker(): boolean;
  requestPetProjectionSnapshot(): Promise<PetProjectionSnapshotResult | null>;
  subscribePetProjection(
    listener: (event: AgentBridgePetEvent) => void | Promise<void>,
  ): () => void;
}

export interface PetStateAggregatorOptions {
  bridge: PetStateBridge;
  listDiskSessions: (opts: { limit: number; cursor?: string }) => Promise<ListDiskSessionsResult>;
  pageSize?: number;
  now?: () => number;
}

const MAX_TITLE_LENGTH = 160;
const MAX_SUMMARY_LENGTH = 240;

function bounded(value: string | undefined, maximum: number): string | undefined {
  if (!value) return undefined;
  return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
}

function terminalFromDisk(
  status: DiskSessionMeta["status"],
  at: number,
): DesktopPetSession["terminal"] {
  if (!status || status === "active" || status === "paused") return undefined;
  return { status, at };
}

function diskProjection(session: DiskSessionMeta, observedAt: number): DesktopPetSession {
  const terminal = terminalFromDisk(session.status, session.updatedAt);
  return {
    agentSessionId: session.engineSessionId,
    title: bounded(session.title, MAX_TITLE_LENGTH),
    workspaceDisplayName: session.cwd ? bounded(path.basename(session.cwd), 80) : undefined,
    runState: terminal ? "terminal" : "dormant",
    queueDepth: 0,
    lastActivityAt: session.updatedAt,
    pendingDecisionCount: 0,
    terminal,
    freshness: { source: "disk", observedAt, workerState: "reclaimed" },
  };
}

function safeSession(session: PetSessionProjection): DesktopPetSession {
  return {
    agentSessionId: session.agentSessionId,
    title: bounded(session.title, MAX_TITLE_LENGTH),
    workspaceDisplayName: bounded(session.workspaceDisplayName, 80),
    runState: session.runState,
    phase: session.phase,
    summary: bounded(session.summary, MAX_SUMMARY_LENGTH),
    queueDepth: Math.max(0, session.queueDepth),
    lastActivityAt: session.lastActivityAt,
    pendingDecisionCount: Math.max(0, session.pendingDecisionCount),
    terminal: session.terminal,
    freshness: {
      source: session.freshness.source,
      observedAt: session.freshness.observedAt,
      workerState: session.freshness.workerState,
    },
  };
}

function safePending(pending: PendingDecisionProjection): DesktopPendingDecision {
  return {
    agentSessionId: pending.agentSessionId,
    requestId: pending.requestId,
    routeGeneration: pending.routeGeneration,
    workerGeneration: pending.workerGeneration,
    kind: pending.kind,
    title:
      pending.kind === "ask_user"
        ? "需要用户回答"
        : `等待批准 ${bounded(pending.toolName, 80) ?? "工具"}`,
    toolName: bounded(pending.toolName, 80),
    riskLevel: pending.riskLevel,
    createdAt: pending.createdAt,
    expiresAt: pending.expiresAt,
    status: pending.status,
    terminalAt: pending.terminalAt,
  };
}

function pendingKey(sessionId: string, requestId: string): string {
  return `${sessionId}\u0000${requestId}`;
}

export class PetStateAggregator {
  private readonly diskSessions = new Map<string, DesktopPetSession>();
  private readonly diskBindings = new Map<string, PetNavigationTarget>();
  private readonly liveSessions = new Map<string, DesktopPetSession>();
  private readonly pending = new Map<string, DesktopPendingDecision>();
  private readonly listeners = new Set<(event: DesktopPetProjectionEvent) => void>();
  private readonly pageSize: number;
  private readonly now: () => number;
  private generation = 0;
  private sourceVersion = 0;
  private version = 0;
  private observedAt = 0;
  private workerState: DesktopPetWorkerState = "unknown";
  private started = false;
  private unsubscribeBridge?: () => void;
  private reconcilePromise: Promise<void> | null = null;

  constructor(private readonly options: PetStateAggregatorOptions) {
    this.pageSize = options.pageSize ?? 100;
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribeBridge = this.options.bridge.subscribePetProjection((event) =>
      this.handleBridgeEvent(event),
    );
    await this.refreshCatalog(false);
    if (this.options.bridge.hasLiveWorker()) {
      await this.reconcileLive(false);
    } else {
      this.workerState = "reclaimed";
      this.observedAt = this.now();
    }
  }

  stop(): void {
    this.unsubscribeBridge?.();
    this.unsubscribeBridge = undefined;
    this.started = false;
  }

  getSnapshot(): DesktopPetProjectionSnapshot {
    const sessions = new Map(this.diskSessions);
    for (const [sessionId, session] of this.liveSessions) sessions.set(sessionId, session);
    if (this.workerState === "disconnected") {
      for (const [sessionId, session] of sessions) {
        sessions.set(sessionId, {
          ...session,
          runState: "unknown",
          phase: undefined,
          pendingDecisionCount: 0,
          freshness: {
            ...session.freshness,
            observedAt: this.observedAt,
            workerState: "disconnected",
          },
        });
      }
    }
    return {
      version: this.version,
      generation: this.generation,
      workerState: this.workerState,
      sessions: [...sessions.values()].sort((a, b) =>
        a.agentSessionId.localeCompare(b.agentSessionId),
      ),
      pending: [...this.pending.values()].sort(
        (a, b) => a.createdAt - b.createdAt || a.requestId.localeCompare(b.requestId),
      ),
      observedAt: this.observedAt,
    };
  }

  subscribe(listener: (event: DesktopPetProjectionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async resolveNavigation(request: PetNavigationRequest): Promise<PetNavigationResult> {
    await this.refreshCatalog(false);
    const target = this.diskBindings.get(request.agentSessionId);
    if (!target) return { status: "not-found" };

    let stale = request.snapshotVersion !== this.version || request.generation !== this.generation;
    let pendingStatus: "pending" | "resolved" | undefined;
    if (request.requestId) {
      const pending = this.pending.get(pendingKey(request.agentSessionId, request.requestId));
      const routeMatches =
        request.routeGeneration === undefined ||
        pending?.routeGeneration === undefined ||
        request.routeGeneration === pending.routeGeneration;
      const generationMatches = pending?.workerGeneration === request.generation;
      if (!pending || pending.status !== "pending" || !routeMatches || !generationMatches) {
        stale = true;
        pendingStatus = "resolved";
      } else {
        pendingStatus = "pending";
      }
    }
    return { status: stale ? "stale" : "ok", target, pendingStatus };
  }

  async refreshCatalog(emit = true): Promise<void> {
    const next = new Map<string, DesktopPetSession>();
    const nextBindings = new Map<string, PetNavigationTarget>();
    let cursor: string | undefined;
    const observedAt = this.now();
    do {
      const page = await this.options.listDiskSessions({ limit: this.pageSize, cursor });
      for (const session of page.sessions) {
        next.set(session.engineSessionId, diskProjection(session, observedAt));
        nextBindings.set(session.engineSessionId, {
          uiSessionId: session.id,
          engineSessionId: session.engineSessionId,
          projectPath: session.cwd || null,
          title: bounded(session.title, MAX_TITLE_LENGTH) ?? session.id,
          updatedAt: session.updatedAt,
          origin: session.origin,
          status: session.status,
        });
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    this.diskSessions.clear();
    this.diskBindings.clear();
    for (const [sessionId, session] of next) this.diskSessions.set(sessionId, session);
    for (const [sessionId, target] of nextBindings) this.diskBindings.set(sessionId, target);
    this.observedAt = observedAt;
    if (emit) this.emit({ kind: "reset" });
  }

  private async handleBridgeEvent(event: AgentBridgePetEvent): Promise<void> {
    if (event.kind === "lifecycle") {
      if (event.state === "active") {
        await this.reconcileLive();
      } else {
        this.applyWorkerLoss(event.state);
      }
      return;
    }

    const { delta } = event;
    if (delta.workerGeneration < this.generation) return;
    if (delta.workerGeneration !== this.generation) {
      await this.reconcileLive();
    }
    if (delta.workerGeneration !== this.generation || delta.version <= this.sourceVersion) return;
    if (delta.version !== this.sourceVersion + 1) {
      await this.reconcileLive();
      if (delta.workerGeneration !== this.generation || delta.version <= this.sourceVersion) return;
      if (delta.version !== this.sourceVersion + 1) return;
    }
    this.sourceVersion = delta.version;
    this.observedAt = delta.observedAt;
    this.applyDelta(delta);
  }

  private async reconcileLive(emit = true): Promise<void> {
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = this.performReconcile(emit).finally(() => {
      this.reconcilePromise = null;
    });
    return this.reconcilePromise;
  }

  private async performReconcile(emit: boolean): Promise<void> {
    this.workerState = "reconciling";
    this.observedAt = this.now();
    if (emit) this.emit({ kind: "worker-state", state: "reconciling" });
    const snapshot = await this.options.bridge.requestPetProjectionSnapshot();
    if (!snapshot) {
      this.applyWorkerLoss("disconnected", emit);
      return;
    }
    const changedGeneration = snapshot.workerGeneration !== this.generation;
    this.generation = snapshot.workerGeneration;
    if (changedGeneration) this.version = 0;
    this.sourceVersion = snapshot.snapshotVersion;
    this.workerState = "active";
    this.observedAt = snapshot.observedAt;
    this.liveSessions.clear();
    for (const session of snapshot.sessions) {
      const safe = safeSession(session);
      this.liveSessions.set(safe.agentSessionId, safe);
    }
    this.pending.clear();
    for (const pending of snapshot.pending) {
      const safe = safePending(pending);
      this.pending.set(pendingKey(safe.agentSessionId, safe.requestId), safe);
    }
    if (emit) this.emit({ kind: "reset" });
  }

  private applyWorkerLoss(state: "reclaimed" | "disconnected", emit = true): void {
    this.workerState = state;
    this.liveSessions.clear();
    this.pending.clear();
    this.observedAt = this.now();
    if (emit) this.emit({ kind: "reset" });
  }

  private applyDelta(delta: PetProjectionDelta): void {
    switch (delta.kind) {
      case "session-upsert": {
        const session = safeSession(delta.session);
        this.liveSessions.set(session.agentSessionId, session);
        this.emit({ kind: "session-upsert", session });
        break;
      }
      case "session-remove": {
        this.liveSessions.delete(delta.sessionId);
        const disk = this.diskSessions.get(delta.sessionId);
        if (disk) this.emit({ kind: "session-upsert", session: disk });
        else this.emit({ kind: "session-remove", sessionId: delta.sessionId });
        void this.refreshCatalog();
        break;
      }
      case "pending-upsert": {
        const pending = safePending(delta.pending);
        this.pending.set(pendingKey(pending.agentSessionId, pending.requestId), pending);
        this.emit({ kind: "pending-upsert", pending });
        break;
      }
      case "pending-remove":
        this.pending.delete(pendingKey(delta.sessionId, delta.requestId));
        this.emit({
          kind: "pending-remove",
          sessionId: delta.sessionId,
          requestId: delta.requestId,
        });
        break;
      case "worker-state":
        if (delta.state === "disconnected" || delta.state === "reclaimed") {
          this.applyWorkerLoss(delta.state);
        } else {
          this.workerState = delta.state;
          this.emit({ kind: "worker-state", state: delta.state });
        }
        break;
    }
  }

  private emit(event: DesktopPetProjectionEventInput): void {
    const envelope = {
      ...event,
      version: ++this.version,
      generation: this.generation,
      observedAt: this.observedAt,
    } as DesktopPetProjectionEvent;
    for (const listener of this.listeners) listener(envelope);
  }
}

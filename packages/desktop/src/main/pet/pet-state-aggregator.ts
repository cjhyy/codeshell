import type {
  PendingDecisionProjection,
  PetProjectionDelta,
  PetProjectionSnapshotResult,
  PetSessionProjection,
} from "@cjhyy/code-shell-pet";
import path from "node:path";
import type { DiskSessionMeta, ListDiskSessionsResult } from "@cjhyy/code-shell-server/storage";

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
  /** Present on sessions observed from an external CLI's own storage
   *  (Codex/Claude rollouts), not from our worker. */
  external?: { cli: "codex" | "claude"; cwd?: string };
  freshness: {
    source: PetSessionProjection["freshness"]["source"] | "external-tail";
    observedAt: number;
    workerState: DesktopPetWorkerState;
  };
}

export type DesktopPendingDecision = Omit<PendingDecisionProjection, "owner" | "coreSessionId">;

/** One message-keyed topic-segment boundary surfaced to the Mimi chat UI. */
export interface DesktopPetWorkMemorySegment {
  boundaryBeforeMessageId: string;
  brief?: string;
}

export interface DesktopPetProjectionSnapshot {
  version: number;
  generation: number;
  workerState: DesktopPetWorkerState;
  sessions: DesktopPetSession[];
  pending: DesktopPendingDecision[];
  observedAt: number;
  /**
   * Topic-segment boundaries for the Mimi chat stream, keyed by the client
   * message id of each segment's first turn (see DesktopPetWorkMemorySegment).
   * Sourced from PetWorkMemoryStore via the `workMemorySegments` option; empty
   * when no boundary-history provider is wired.
   */
  workMemorySegments: DesktopPetWorkMemorySegment[];
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
  | { kind: "work-memory-segments"; segments: DesktopPetWorkMemorySegment[] }
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
  /** Full durable-catalog reconciliation cadence. Set to 0 to disable. */
  catalogRefreshIntervalMs?: number;
  now?: () => number;
  onBackgroundError?: (operation: string, error: unknown) => void;
  /**
   * Reads the current message-keyed topic-segment boundaries from durable work
   * memory (PetWorkMemoryStore.segmentBoundaries). Included verbatim in every
   * snapshot so the Mimi chat UI can render segment dividers + brief cards; live
   * changes are pushed via `notifyWorkMemorySegmentsChanged`. Omitted → empty.
   */
  workMemorySegments?: () => DesktopPetWorkMemorySegment[];
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
  private readonly externalSessions = new Map<string, DesktopPetSession>();
  private readonly pending = new Map<string, DesktopPendingDecision>();
  private readonly listeners = new Set<(event: DesktopPetProjectionEvent) => void>();
  private readonly pageSize: number;
  private readonly catalogRefreshIntervalMs: number;
  private readonly now: () => number;
  private generation = 0;
  private sourceVersion = 0;
  private version = 0;
  private observedAt = 0;
  /**
   * Largest disk mtime observed by the last catalog refresh. `undefined` until
   * the first refresh, which forces that pass to be full.
   */
  private lastHighWaterMtime: number | undefined;
  private workerState: DesktopPetWorkerState = "unknown";
  private started = false;
  private unsubscribeBridge?: () => void;
  private reconcilePromise: Promise<void> | null = null;
  private catalogRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private periodicCatalogRefreshRunning = false;
  /**
   * AgentBridge deliberately does not await observers, so consecutive worker
   * notifications may otherwise enter `handleBridgeEvent` concurrently. Some
   * deltas (notably finalizing session updates) await disk reconciliation;
   * serialize the whole stream so an older event can never be emitted after a
   * newer one.
   */
  private bridgeEventQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: PetStateAggregatorOptions) {
    this.pageSize = options.pageSize ?? 100;
    this.catalogRefreshIntervalMs = options.catalogRefreshIntervalMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    let releaseStartupBarrier!: () => void;
    const startupBarrier = new Promise<void>((resolve) => {
      releaseStartupBarrier = resolve;
    });
    // Subscribe before the first await so no worker notification is lost, but
    // hold delivery until the durable catalog and initial live snapshot form
    // one coherent baseline.
    this.bridgeEventQueue = this.bridgeEventQueue.then(() => startupBarrier);
    this.unsubscribeBridge = this.options.bridge.subscribePetProjection((event) =>
      this.enqueueBridgeEvent(event),
    );
    try {
      await this.refreshCatalog(false);
      if (this.options.bridge.hasLiveWorker()) {
        await this.reconcileLive(false);
      } else {
        this.workerState = "reclaimed";
        this.observedAt = this.now();
      }
    } finally {
      releaseStartupBarrier();
    }
    if (this.catalogRefreshIntervalMs > 0) {
      this.catalogRefreshTimer = setInterval(() => {
        if (this.periodicCatalogRefreshRunning) return;
        this.periodicCatalogRefreshRunning = true;
        // A full pass also observes sessions archived/deleted outside this
        // worker; incremental high-water refreshes cannot see an absence.
        void this.refreshCatalog(true, { full: true })
          .catch((error) => this.options.onBackgroundError?.("periodic-catalog-refresh", error))
          .finally(() => {
            this.periodicCatalogRefreshRunning = false;
          });
      }, this.catalogRefreshIntervalMs);
      (
        this.catalogRefreshTimer as ReturnType<typeof setInterval> & { unref?: () => void }
      ).unref?.();
    }
  }

  stop(): void {
    this.unsubscribeBridge?.();
    this.unsubscribeBridge = undefined;
    if (this.catalogRefreshTimer) clearInterval(this.catalogRefreshTimer);
    this.catalogRefreshTimer = null;
    this.started = false;
  }

  getSnapshot(): DesktopPetProjectionSnapshot {
    const sessions = new Map(this.diskSessions);
    for (const [sessionId, session] of this.liveSessions) {
      sessions.set(sessionId, this.withDurableOverlay(session));
    }
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
    // External-CLI sessions merge in after the disconnected overlay so worker
    // loss never rewrites them to `unknown` — they do not depend on the worker.
    for (const [sessionId, session] of this.externalSessions) {
      sessions.set(sessionId, session);
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
      workMemorySegments: this.options.workMemorySegments?.() ?? [],
    };
  }

  /**
   * Push a fresh set of topic-segment boundaries to subscribers as a projection
   * event, so a segment opened mid-session surfaces its divider without waiting
   * for the next full snapshot fetch. Called after PetSegmentController records a
   * new boundary.
   */
  notifyWorkMemorySegmentsChanged(): void {
    this.observedAt = this.now();
    this.emit({
      kind: "work-memory-segments",
      segments: this.options.workMemorySegments?.() ?? [],
    });
  }

  subscribe(listener: (event: DesktopPetProjectionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** External-CLI source (Codex/Claude adapters). Independent of the worker:
   *  lifecycle loss must not clear or overlay these. */
  upsertExternalSession(session: DesktopPetSession): void {
    this.externalSessions.set(session.agentSessionId, session);
    this.observedAt = this.now();
    this.emit({ kind: "session-upsert", session });
  }

  removeExternalSession(agentSessionId: string): void {
    if (!this.externalSessions.delete(agentSessionId)) return;
    this.observedAt = this.now();
    this.emit({ kind: "session-remove", sessionId: agentSessionId });
  }

  async resolveNavigation(request: PetNavigationRequest): Promise<PetNavigationResult> {
    // Navigation must reflect deletions/soft-deletes, so rebuild from scratch.
    await this.refreshCatalog(false, { full: true });
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

  /**
   * Reconcile the durable catalog from disk. `listDiskSessions` serves sessions
   * mtime-descending, so a refresh only needs to page the band whose mtime is at
   * or above the previous high-water mark — everything below it is older and was
   * already captured. Incremental refreshes therefore stop at the first session
   * strictly below the watermark and upsert the rest onto the held catalog.
   *
   * Correctness notes:
   * - Same-mtime newcomers: the stop is strict (`< watermark`), so the whole
   *   band *at* the watermark is always re-paged. A brand-new session sharing the
   *   watermark mtime whose id sorts after an already-held one is not skipped
   *   (a `<=` stop would break on the held session and miss it).
   * - Deletions / soft-deletes (archival flips a session out of the default
   *   listing and bumps its mtime ahead): the mtime cursor cannot observe a
   *   session that has left the listing, and incremental upserts never remove.
   *   Delete-aware callers therefore pass `{ full: true }` to rebuild from
   *   scratch; the first refresh (no watermark yet) is implicitly full.
   */
  async refreshCatalog(emit = true, opts: { full?: boolean } = {}): Promise<void> {
    const observedAt = this.now();
    const full = opts.full ?? this.lastHighWaterMtime === undefined;
    const next = full ? new Map<string, DesktopPetSession>() : new Map(this.diskSessions);
    const nextBindings = full ? new Map<string, PetNavigationTarget>() : new Map(this.diskBindings);
    let newHighWater = full ? 0 : this.lastHighWaterMtime!;
    let cursor: string | undefined;
    pager: do {
      const page = await this.options.listDiskSessions({ limit: this.pageSize, cursor });
      for (const session of page.sessions) {
        // Once we descend strictly below the prior high-water mark, every
        // remaining session is older and already held: stop paging.
        if (!full && session.updatedAt < this.lastHighWaterMtime!) break pager;
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
        newHighWater = Math.max(newHighWater, session.updatedAt);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    this.diskSessions.clear();
    this.diskBindings.clear();
    for (const [sessionId, session] of next) this.diskSessions.set(sessionId, session);
    for (const [sessionId, target] of nextBindings) this.diskBindings.set(sessionId, target);
    this.lastHighWaterMtime = newHighWater;
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
    await this.applyDelta(delta);
  }

  private enqueueBridgeEvent(event: AgentBridgePetEvent): Promise<void> {
    const pending = this.bridgeEventQueue.then(() => this.handleBridgeEvent(event));
    // Keep the internal queue usable if one observer turn rejects. Return the
    // original promise so AgentBridge can still report the actual failure.
    this.bridgeEventQueue = pending.catch(() => undefined);
    return pending;
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
    let snapshot: PetProjectionSnapshotResult | null;
    try {
      snapshot = await this.options.bridge.requestPetProjectionSnapshot();
    } catch {
      this.applyWorkerLoss("disconnected", emit);
      return;
    }
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

  private async applyDelta(delta: PetProjectionDelta): Promise<void> {
    switch (delta.kind) {
      case "session-upsert": {
        const session = safeSession(delta.session);
        this.liveSessions.set(session.agentSessionId, session);
        if (session.phase === "finalizing" && !session.terminal) {
          try {
            await this.refreshCatalog(false);
          } catch {
            // The live projection remains usable when durable reconciliation fails.
          }
          this.observedAt = Math.max(this.observedAt, delta.observedAt);
        }
        this.emit({ kind: "session-upsert", session: this.withDurableOverlay(session) });
        break;
      }
      case "session-remove": {
        this.liveSessions.delete(delta.sessionId);
        const disk = this.diskSessions.get(delta.sessionId);
        if (disk) this.emit({ kind: "session-upsert", session: disk });
        else this.emit({ kind: "session-remove", sessionId: delta.sessionId });
        // A removal is only visible via a full rebuild; the mtime cursor cannot
        // observe a session that has left the listing.
        void this.refreshCatalog(true, { full: true }).catch((error) => {
          this.options.onBackgroundError?.("session-remove-refresh", error);
        });
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

  private withDurableOverlay(session: DesktopPetSession): DesktopPetSession {
    const durable = this.diskSessions.get(session.agentSessionId);
    const reconciledTerminal =
      !session.terminal &&
      session.phase === "finalizing" &&
      durable?.terminal &&
      durable.lastActivityAt >= session.lastActivityAt
        ? durable.terminal
        : undefined;
    return {
      ...session,
      title: session.title ?? durable?.title,
      workspaceDisplayName: session.workspaceDisplayName ?? durable?.workspaceDisplayName,
      ...(reconciledTerminal
        ? {
            runState: "terminal" as const,
            phase: undefined,
            terminal: reconciledTerminal,
            lastActivityAt: Math.max(session.lastActivityAt, durable?.lastActivityAt ?? 0),
          }
        : {}),
    };
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

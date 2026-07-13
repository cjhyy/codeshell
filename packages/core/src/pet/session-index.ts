import type { StreamEvent, TerminalReason } from "../types.js";
import {
  LOCAL_PET_OWNER,
  type PetCatalogSession,
  type PetLiveSessionsSnapshot,
  type PetOwnerScopedCatalog,
  type PetProjectionCursor,
  type PetSessionProjection,
  type PetSessionStreamEvent,
  type PetTerminalStatus,
  type PetWorkerLifecycleEvent,
  type PetWorkerState,
} from "./types.js";

interface SessionIndexEntry {
  catalog: PetCatalogSession;
  projection: PetSessionProjection;
  live: boolean;
  beforePending?: Pick<PetSessionProjection, "phase" | "summary">;
}

function isWorkSession(session: PetCatalogSession): boolean {
  if (session.kind === "pet" || session.ephemeral) return false;
  if (session.origin === "subagent") return false;
  if (typeof session.parentSessionId === "string") return false;
  return true;
}

function terminalStatus(reason: TerminalReason): PetTerminalStatus {
  if (reason === "completed") return "completed";
  if (reason === "aborted_streaming") return "cancelled";
  return "failed";
}

function diskTerminalStatus(status: PetCatalogSession["status"]): PetTerminalStatus | undefined {
  if (!status || status === "active" || status === "paused") return undefined;
  return terminalStatus(status);
}

function safeToolName(toolName: string): string {
  const firstLine = toolName.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (/(?:sk|api|token|secret)[-_][a-z0-9_-]{6,}/i.test(firstLine)) return "工具";
  const safe = firstLine
    .replace(/[^\p{L}\p{N}_.:@/-]+/gu, " ")
    .trim()
    .slice(0, 40);
  return safe || "工具";
}

function baseProjection(
  catalog: PetCatalogSession,
  observedAt: number,
  workerState: PetWorkerState,
): PetSessionProjection {
  const status = diskTerminalStatus(catalog.status);
  return {
    owner: LOCAL_PET_OWNER,
    agentSessionId: catalog.sessionId,
    coreSessionId: catalog.sessionId,
    title: catalog.title,
    workspaceDisplayName: catalog.workspaceDisplayName,
    runState: status ? "terminal" : "dormant",
    queueDepth: 0,
    lastActivityAt: catalog.updatedAt,
    pendingDecisionCount: 0,
    terminal: status ? { status, at: catalog.updatedAt } : undefined,
    freshness: { source: "disk", observedAt, workerState },
  };
}

/** Pure, owner-scoped materialized view over durable catalog and ordered live inputs. */
export class SessionIndex {
  private readonly entries = new Map<string, SessionIndexEntry>();
  private generation = 0;
  private version = 0;
  private currentWorkerState: PetWorkerState = "unknown";

  replaceCatalog(catalog: PetOwnerScopedCatalog): void {
    if (catalog.owner !== LOCAL_PET_OWNER) return;
    const next = new Map<string, SessionIndexEntry>();
    for (const session of catalog.sessions) {
      if (!isWorkSession(session)) continue;
      const previous = this.entries.get(session.sessionId);
      next.set(session.sessionId, {
        catalog: { ...session },
        projection: previous?.live
          ? {
              ...previous.projection,
              title: session.title,
              workspaceDisplayName: session.workspaceDisplayName,
            }
          : baseProjection(session, catalog.observedAt, this.currentWorkerState),
        live: previous?.live ?? false,
        beforePending: previous?.beforePending,
      });
    }
    this.entries.clear();
    for (const [sessionId, entry] of next) this.entries.set(sessionId, entry);
  }

  applyLiveSnapshot(snapshot: PetLiveSessionsSnapshot): boolean {
    if (!this.acceptCursor(snapshot)) return false;
    this.currentWorkerState = "active";
    for (const entry of this.entries.values()) {
      entry.projection = baseProjection(entry.catalog, snapshot.observedAt, "active");
      entry.live = false;
      entry.beforePending = undefined;
    }
    for (const live of snapshot.sessions) {
      const entry = this.entries.get(live.sessionId);
      if (!entry) continue;
      entry.live = true;
      entry.projection = {
        ...entry.projection,
        runState: live.busy ? "running" : live.queueDepth > 0 ? "queued" : "idle",
        queueDepth: Math.max(0, live.queueDepth),
        lastActivityAt: live.lastActivityAt,
        terminal: undefined,
        freshness: {
          source: "live-snapshot",
          observedAt: snapshot.observedAt,
          workerState: "active",
        },
      };
    }
    return true;
  }

  applyStreamEvent(input: PetSessionStreamEvent): boolean {
    if (!this.acceptCursor(input)) return false;
    const entry = this.entries.get(input.sessionId);
    if (!entry) return true;
    entry.live = true;
    this.currentWorkerState = "active";
    if (entry.projection.pendingDecisionCount > 0 && entry.beforePending) {
      const underlying = this.reduceEvent(
        {
          ...entry.projection,
          phase: entry.beforePending.phase,
          summary: entry.beforePending.summary,
          pendingDecisionCount: 0,
        },
        input.event,
        input.observedAt,
      );
      entry.beforePending = { phase: underlying.phase, summary: underlying.summary };
      entry.projection = {
        ...underlying,
        phase: "waiting-decision",
        summary:
          entry.projection.pendingDecisionCount === 1
            ? "等待用户决定"
            : `等待用户决定（${entry.projection.pendingDecisionCount}）`,
        pendingDecisionCount: entry.projection.pendingDecisionCount,
      };
    } else {
      entry.projection = this.reduceEvent(entry.projection, input.event, input.observedAt);
    }
    return true;
  }

  setPendingDecisionCount(sessionId: string, count: number, cursor: PetProjectionCursor): boolean {
    if (!this.acceptCursor(cursor)) return false;
    const entry = this.entries.get(sessionId);
    if (!entry) return true;
    const pendingDecisionCount = Math.max(0, Math.floor(count));
    const wasWaiting = entry.projection.phase === "waiting-decision";
    if (pendingDecisionCount > 0 && entry.projection.pendingDecisionCount === 0) {
      entry.beforePending = {
        phase: entry.projection.phase,
        summary: entry.projection.summary,
      };
    }
    const beforePending = entry.beforePending;
    entry.projection = {
      ...entry.projection,
      phase:
        pendingDecisionCount > 0
          ? "waiting-decision"
          : wasWaiting
            ? beforePending?.phase
            : entry.projection.phase,
      pendingDecisionCount,
      summary:
        pendingDecisionCount > 0
          ? pendingDecisionCount === 1
            ? "等待用户决定"
            : `等待用户决定（${pendingDecisionCount}）`
          : wasWaiting
            ? beforePending?.summary
            : entry.projection.summary,
      freshness: {
        source: "live-event",
        observedAt: cursor.observedAt,
        workerState: "active",
      },
    };
    if (pendingDecisionCount === 0) entry.beforePending = undefined;
    entry.live = true;
    return true;
  }

  applyWorkerLifecycle(event: PetWorkerLifecycleEvent): boolean {
    if (!this.acceptCursor(event)) return false;
    this.currentWorkerState = event.state;
    if (event.state === "active") return true;
    for (const entry of this.entries.values()) {
      if (event.state === "reclaimed") {
        entry.projection = baseProjection(entry.catalog, event.observedAt, "reclaimed");
        entry.live = false;
        entry.beforePending = undefined;
        continue;
      }
      if (!entry.live) continue;
      entry.projection = {
        ...entry.projection,
        runState: "unknown",
        phase: undefined,
        summary: "Live 状态未知",
        queueDepth: 0,
        pendingDecisionCount: 0,
        terminal: undefined,
        freshness: {
          source: "live-event",
          observedAt: event.observedAt,
          workerState: "disconnected",
        },
      };
      entry.beforePending = undefined;
    }
    return true;
  }

  get(sessionId: string): PetSessionProjection | undefined {
    const value = this.entries.get(sessionId)?.projection;
    return value ? structuredClone(value) : undefined;
  }

  list(): PetSessionProjection[] {
    return [...this.entries.values()]
      .map((entry) => structuredClone(entry.projection))
      .sort((a, b) => a.agentSessionId.localeCompare(b.agentSessionId));
  }

  cursor(): { generation: number; version: number } {
    return { generation: this.generation, version: this.version };
  }

  workerState(): PetWorkerState {
    return this.currentWorkerState;
  }

  private acceptCursor(cursor: PetProjectionCursor): boolean {
    if (cursor.generation < this.generation) return false;
    if (cursor.generation === this.generation && cursor.version <= this.version) return false;
    this.generation = cursor.generation;
    this.version = cursor.version;
    return true;
  }

  private reduceEvent(
    current: PetSessionProjection,
    event: StreamEvent,
    observedAt: number,
  ): PetSessionProjection {
    const next: PetSessionProjection = {
      ...current,
      lastActivityAt: observedAt,
      freshness: { source: "live-event", observedAt, workerState: "active" },
    };
    switch (event.type) {
      case "stream_request_start":
        return {
          ...next,
          runState: "running",
          phase: "model",
          summary: "模型处理中",
          terminal: undefined,
        };
      case "tool_use_start":
        return {
          ...next,
          runState: "running",
          phase: "tool",
          summary: `正在运行 ${safeToolName(event.toolCall.toolName)}`.slice(0, 64),
          terminal: undefined,
        };
      case "context_compact":
        return {
          ...next,
          runState: "running",
          phase: "compacting",
          summary: "正在整理上下文",
          terminal: undefined,
        };
      case "turn_complete": {
        const status = terminalStatus(event.reason);
        return {
          ...next,
          runState: current.queueDepth > 0 ? "queued" : "terminal",
          phase: current.queueDepth > 0 ? undefined : "finalizing",
          summary:
            current.queueDepth > 0
              ? "队列中"
              : status === "completed"
                ? "本轮已完成"
                : "运行已结束",
          terminal: current.queueDepth > 0 ? undefined : { status, at: observedAt },
        };
      }
      case "error":
        return {
          ...next,
          runState: "terminal",
          phase: "finalizing",
          summary: "运行失败",
          terminal: { status: "failed", at: observedAt },
        };
      default:
        return next;
    }
  }
}

/**
 * In-process async agent registry.
 *
 * When an Agent tool call uses run_in_background: true, the sub-agent
 * runs detached from the current turn. We need somewhere to track
 * agentId → status / result / cancel handle so the parent agent can
 * later check on it (AgentStatus) or cancel it (AgentCancel).
 *
 * Lifetime: process-local. Crashing the process loses these — that's
 * the same contract Claude Code's Agent.run_in_background gives, and
 * the right boundary: long-running cross-process work belongs to
 * RunManager, not here.
 */

export type AsyncAgentStatus = "running" | "cancelling" | "completed" | "failed" | "cancelled";

import type {
  DirectionAck,
  DirectionDelivery,
  DirectionEnvelopeDraft,
  DirectionRejectReason,
  ProgressPayload,
} from "./agent-notifications.js";
import { notificationQueue } from "./agent-notifications.js";

export type { DirectionAck } from "./agent-notifications.js";

export type LiveChildState =
  | "starting"
  | "model"
  | "tool-batch"
  | "safe-point"
  | "interrupting"
  | "redriving"
  | "closing"
  | "terminal";

export interface LiveChildControl {
  readonly childSessionId: string;
  readonly runtimeGeneration: number;
  getState(): LiveChildState;
  routeDirection(draft: DirectionEnvelopeDraft): DirectionAck | Promise<DirectionAck>;
}

export interface ChildWriterLease {
  childSessionId: string;
  runtimeGeneration: number;
  ownerToken: string;
}

export interface RouteDirectionRequest {
  callerSessionId: string;
  callerIsSubAgent: boolean;
  agentId: string;
  prompt: string;
  delivery: DirectionDelivery;
}

/** Process-wide cap on concurrent background sub-agents (aligns with Codex max_threads=6). */
export const MAX_BACKGROUND_AGENTS = 6;

/**
 * Minimal structural shape for an entry in an agent's transcript. We avoid
 * importing the UI's `ChatEntry` here to prevent a tool-system → ui import
 * direction. Consumers (the UI dock) widen this type via `as ChatEntry[]`
 * at their boundary.
 */
export interface AgentTranscriptEntry {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface AsyncAgentEntry {
  agentId: string;
  /** Short kind label shown in the dock (e.g. "Explore", "Plan"). */
  name?: string;
  /** Dispatched role (e.g. "general-purpose", "explorer"); shown in the dock
   *  so you can see what kind of agent is running. */
  agentType?: string;
  description: string;
  /** Session that spawned this background agent. Lets the spawning
   *  Engine.run wait only on ITS OWN background agents (hasRunningForSession),
   *  not every concurrent session's. Undefined only for legacy/ad-hoc callers
   *  outside Engine.run. */
  sessionId?: string;
  /** The sub-agent's OWN child session id (distinct from the parent
   *  `sessionId` above). AgentSendInput resumes this to continue the agent
   *  with full transcript replay. With the agent_id===childSid convention
   *  this equals `agentId`, but it is stored explicitly so the contract is
   *  not coupled to that identity. Undefined for legacy entries. */
  childSessionId?: string;
  runtimeGeneration?: number;
  liveControl?: LiveChildControl;
  writerLease?: ChildWriterLease;
  progress?: ProgressPayload;
  status: AsyncAgentStatus;
  startedAt: number;
  finishedAt?: number;
  /** finishedAt + 30_000. Dock filters rows past this. */
  finishedFadeAt?: number;
  abort: () => void;
  /** Stream events recorded by run_in_background agents for UI view-switching. */
  transcript?: AgentTranscriptEntry[];
}

class AsyncAgentRegistry {
  private agents = new Map<string, AsyncAgentEntry>();
  private listeners = new Set<() => void>();
  private snapshot: AsyncAgentEntry[] = [];
  private writerLeases = new Map<string, ChildWriterLease>();
  private generationByChildSession = new Map<string, number>();
  private closedDirectionIntake = new Set<string>();

  // ── observer API (React useSyncExternalStore compatible) ──────────────

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  getSnapshot = (): AsyncAgentEntry[] => {
    return this.snapshot;
  };

  hasRunning = (): boolean => {
    return this.snapshot.some((e) => e.status === "running" || e.status === "cancelling");
  };

  /** True if any background agent spawned by `sessionId` is still running.
   *  Drives Engine.run's "wait for my background agents before resolving". */
  hasRunningForSession = (sessionId: string): boolean => {
    return this.snapshot.some(
      (e) => (e.status === "running" || e.status === "cancelling") && e.sessionId === sessionId,
    );
  };

  /** Count of agents currently in the "running" state (cap enforcement). */
  runningCount(): number {
    return this.snapshot.filter((e) => e.status === "running" || e.status === "cancelling").length;
  }

  private notify(): void {
    this.snapshot = [...this.agents.values()];
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
        // isolate per-listener errors
      }
    }
  }

  // ── mutators ──────────────────────────────────────────────────────────

  register(entry: AsyncAgentEntry): void {
    if (entry.childSessionId && entry.runtimeGeneration === undefined) {
      const generation = (this.generationByChildSession.get(entry.childSessionId) ?? 0) + 1;
      entry.runtimeGeneration = generation;
      this.generationByChildSession.set(entry.childSessionId, generation);
    } else if (entry.childSessionId && entry.runtimeGeneration !== undefined) {
      this.generationByChildSession.set(
        entry.childSessionId,
        Math.max(
          this.generationByChildSession.get(entry.childSessionId) ?? 0,
          entry.runtimeGeneration,
        ),
      );
    }
    this.closedDirectionIntake.delete(entry.agentId);
    this.agents.set(entry.agentId, entry);
    this.notify();
  }

  allocateRuntimeGeneration(childSessionId: string): number {
    const generation = (this.generationByChildSession.get(childSessionId) ?? 0) + 1;
    this.generationByChildSession.set(childSessionId, generation);
    return generation;
  }

  acquireWriterLease(
    childSessionId: string,
    runtimeGeneration: number,
    ownerToken: string,
  ): ChildWriterLease | undefined {
    if (!childSessionId || !ownerToken || !Number.isSafeInteger(runtimeGeneration))
      return undefined;
    if (this.writerLeases.has(childSessionId)) return undefined;
    const lease = { childSessionId, runtimeGeneration, ownerToken };
    this.writerLeases.set(childSessionId, lease);
    return lease;
  }

  getWriterLease(childSessionId: string): ChildWriterLease | undefined {
    return this.writerLeases.get(childSessionId);
  }

  releaseWriterLease(lease: ChildWriterLease): boolean {
    const held = this.writerLeases.get(lease.childSessionId);
    if (
      held?.ownerToken !== lease.ownerToken ||
      held.runtimeGeneration !== lease.runtimeGeneration
    ) {
      return false;
    }
    this.writerLeases.delete(lease.childSessionId);
    return true;
  }

  bindLiveControl(agentId: string, control: LiveChildControl, lease: ChildWriterLease): boolean {
    const entry = this.agents.get(agentId);
    const held = this.writerLeases.get(lease.childSessionId);
    if (
      !entry ||
      entry.status !== "running" ||
      entry.childSessionId !== control.childSessionId ||
      entry.childSessionId !== lease.childSessionId ||
      entry.runtimeGeneration !== control.runtimeGeneration ||
      entry.runtimeGeneration !== lease.runtimeGeneration ||
      held?.ownerToken !== lease.ownerToken
    ) {
      return false;
    }
    entry.liveControl = control;
    entry.writerLease = lease;
    this.notify();
    return true;
  }

  closeDirectionIntake(agentId: string, lease: ChildWriterLease): boolean {
    const entry = this.agents.get(agentId);
    const held = this.writerLeases.get(lease.childSessionId);
    if (
      !entry ||
      entry.childSessionId !== lease.childSessionId ||
      entry.runtimeGeneration !== lease.runtimeGeneration ||
      entry.writerLease?.ownerToken !== lease.ownerToken ||
      held?.ownerToken !== lease.ownerToken ||
      held.runtimeGeneration !== lease.runtimeGeneration
    ) {
      return false;
    }
    this.closedDirectionIntake.add(agentId);
    return true;
  }

  updateProgress(agentId: string, progress: ProgressPayload): boolean {
    const entry = this.agents.get(agentId);
    if (!entry || entry.status !== "running") return false;
    entry.progress = progress;
    this.notify();
    return true;
  }

  routeDirection(request: RouteDirectionRequest): DirectionAck | Promise<DirectionAck> {
    const rejected = (
      reason: DirectionRejectReason,
      target?: { sessionId: string; agentId?: string; authority: "agent" },
    ): DirectionAck => ({
      status: "rejected",
      reason,
      ...(target ? { target } : {}),
      rejectedAt: Date.now(),
    });
    if (!request.prompt.trim()) return rejected("invalid-request");
    const entry = this.agents.get(request.agentId);
    if (!entry) return rejected("target-not-found");
    const target = entry.childSessionId
      ? { sessionId: entry.childSessionId, agentId: entry.agentId, authority: "agent" as const }
      : undefined;
    if (request.callerIsSubAgent || entry.sessionId !== request.callerSessionId) {
      return rejected("not-direct-parent", target);
    }
    if (entry.status !== "running") return rejected("target-not-running", target);
    if (this.closedDirectionIntake.has(entry.agentId)) return rejected("intake-closed", target);
    if (!entry.liveControl || !entry.writerLease || !target)
      return rejected("target-not-ready", target);
    const held = this.writerLeases.get(entry.writerLease.childSessionId);
    if (
      entry.liveControl.runtimeGeneration !== entry.runtimeGeneration ||
      entry.writerLease.runtimeGeneration !== entry.runtimeGeneration ||
      held?.runtimeGeneration !== entry.runtimeGeneration ||
      held.ownerToken !== entry.writerLease.ownerToken
    ) {
      return rejected("runtime-generation-mismatch", target);
    }
    return entry.liveControl.routeDirection({
      kind: "direction",
      from: { sessionId: request.callerSessionId, authority: "agent" },
      to: target,
      delivery: request.delivery,
      runtimeGeneration: entry.runtimeGeneration,
      payload: { prompt: request.prompt, origin: "agent_send_input" },
    });
  }

  appendToTranscript(agentId: string, entry: AgentTranscriptEntry): void {
    const e = this.agents.get(agentId);
    if (!e) return;
    if (!e.transcript) e.transcript = [];
    e.transcript.push(entry);
    this.notify();
  }

  /**
   * Re-emit the registry change signal after callers mutate an agent's
   * transcript array in place (patching or filtering entries). Required
   * because `notify` rebuilds the snapshot and tells React subscribers to
   * re-read.
   */
  touchTranscript(agentId: string): void {
    if (!this.agents.has(agentId)) return;
    this.notify();
  }

  get(agentId: string): AsyncAgentEntry | undefined {
    return this.agents.get(agentId);
  }

  list(): AsyncAgentEntry[] {
    return [...this.agents.values()];
  }

  /**
   * Agents spawned by a given session. Drives AgentStatus's default view so a
   * background-agent listing doesn't surface every concurrent session's agents.
   * Legacy entries with no sessionId are excluded from a session-scoped query.
   */
  listForSession(sessionId: string): AsyncAgentEntry[] {
    return [...this.agents.values()].filter((e) => e.sessionId === sessionId);
  }

  completeTerminal(
    agentId: string,
    status: "completed" | "failed" | "cancelled",
    lease: ChildWriterLease,
  ): boolean {
    const e = this.agents.get(agentId);
    const held = this.writerLeases.get(lease.childSessionId);
    if (
      !e ||
      (e.status !== "running" && e.status !== "cancelling") ||
      e.childSessionId !== lease.childSessionId ||
      e.runtimeGeneration !== lease.runtimeGeneration ||
      e.writerLease?.ownerToken !== lease.ownerToken ||
      held?.ownerToken !== lease.ownerToken ||
      held.runtimeGeneration !== lease.runtimeGeneration
    ) {
      return false;
    }
    e.status = status;
    e.finishedAt = Date.now();
    e.finishedFadeAt = e.finishedAt + 30_000;
    this.closedDirectionIntake.add(agentId);
    this.writerLeases.delete(lease.childSessionId);
    if (e.sessionId) notificationQueue.clearProgress(e.sessionId, agentId, lease.runtimeGeneration);
    notificationQueue.clearDirections(lease.childSessionId, lease.runtimeGeneration);
    e.liveControl = undefined;
    e.writerLease = undefined;
    e.progress = undefined;
    this.notify();
    return true;
  }

  private markFinished(agentId: string, status: "completed" | "failed" | "cancelled"): void {
    const e = this.agents.get(agentId);
    if (!e || (e.status !== "running" && e.status !== "cancelling")) return;
    // Live runtimes require the full generation/owner fence. Their supervisor
    // must call completeTerminal after Engine.run has completely settled.
    if (e.writerLease) return;
    e.status = status;
    e.finishedAt = Date.now();
    e.finishedFadeAt = e.finishedAt + 30_000;
    this.closedDirectionIntake.add(agentId);
    if (e.sessionId && e.runtimeGeneration !== undefined) {
      notificationQueue.clearProgress(e.sessionId, agentId, e.runtimeGeneration);
    }
    e.liveControl = undefined;
    e.progress = undefined;
    this.notify();
  }

  markCompleted(agentId: string): void {
    this.markFinished(agentId, "completed");
  }

  markFailed(agentId: string): void {
    this.markFinished(agentId, "failed");
  }

  markCancelled(agentId: string): void {
    this.markFinished(agentId, "cancelled");
  }

  cancel(agentId: string): boolean {
    const e = this.agents.get(agentId);
    if (!e) return false;
    if (e.status !== "running") return false;
    e.status = "cancelling";
    this.closedDirectionIntake.add(agentId);
    if (e.sessionId && e.runtimeGeneration !== undefined) {
      notificationQueue.clearProgress(e.sessionId, agentId, e.runtimeGeneration);
    }
    e.progress = undefined;
    this.notify();
    try {
      e.abort();
    } catch {
      // ignore abort errors — we still mark cancelled
    }
    // Legacy/ad-hoc entries have no live writer lease to fence. There is no
    // supervisor terminal callback coming for them, so preserve their historic
    // immediate terminal bookkeeping after the abort request.
    if (!e.writerLease) this.markFinished(agentId, "cancelled");
    return true;
  }

  reset(): void {
    for (const e of this.agents.values()) {
      if (e.status === "running" || e.status === "cancelling") {
        try {
          e.abort();
        } catch {
          // ignore
        }
      }
    }
    this.agents.clear();
    this.writerLeases.clear();
    this.generationByChildSession.clear();
    this.closedDirectionIntake.clear();
    this.notify();
  }
}

export const asyncAgentRegistry = new AsyncAgentRegistry();

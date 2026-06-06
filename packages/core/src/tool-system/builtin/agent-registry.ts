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

export type AsyncAgentStatus = "running" | "completed" | "failed" | "cancelled";

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
    return this.snapshot.some((e) => e.status === "running");
  };

  /** True if any background agent spawned by `sessionId` is still running.
   *  Drives Engine.run's "wait for my background agents before resolving". */
  hasRunningForSession = (sessionId: string): boolean => {
    return this.snapshot.some((e) => e.status === "running" && e.sessionId === sessionId);
  };

  /** Count of agents currently in the "running" state (cap enforcement). */
  runningCount(): number {
    return this.snapshot.filter((e) => e.status === "running").length;
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
    this.agents.set(entry.agentId, entry);
    this.notify();
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

  private markFinished(agentId: string, status: "completed" | "failed" | "cancelled"): void {
    const e = this.agents.get(agentId);
    if (!e) return;
    if (e.status !== "running") return;
    e.status = status;
    e.finishedAt = Date.now();
    e.finishedFadeAt = e.finishedAt + 30_000;
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
    try {
      e.abort();
    } catch {
      // ignore abort errors — we still mark cancelled
    }
    // Reuse markFinished for the status/timestamp/notify bookkeeping rather
    // than duplicating it (the entry is still "running" after abort()).
    this.markFinished(agentId, "cancelled");
    return true;
  }

  reset(): void {
    for (const e of this.agents.values()) {
      if (e.status === "running") {
        try {
          e.abort();
        } catch {
          // ignore
        }
      }
    }
    this.agents.clear();
    this.notify();
  }
}

export const asyncAgentRegistry = new AsyncAgentRegistry();

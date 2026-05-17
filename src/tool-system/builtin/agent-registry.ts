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
  description: string;
  status: AsyncAgentStatus;
  startedAt: number;
  finishedAt?: number;
  result?: string;
  error?: string;
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

  get(agentId: string): AsyncAgentEntry | undefined {
    return this.agents.get(agentId);
  }

  list(): AsyncAgentEntry[] {
    return [...this.agents.values()];
  }

  markCompleted(agentId: string, result: string): void {
    const e = this.agents.get(agentId);
    if (!e) return;
    if (e.status !== "running") return;
    e.status = "completed";
    e.result = result;
    e.finishedAt = Date.now();
    this.notify();
  }

  markFailed(agentId: string, error: string): void {
    const e = this.agents.get(agentId);
    if (!e) return;
    if (e.status !== "running") return;
    e.status = "failed";
    e.error = error;
    e.finishedAt = Date.now();
    this.notify();
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
    e.status = "cancelled";
    e.finishedAt = Date.now();
    this.notify();
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

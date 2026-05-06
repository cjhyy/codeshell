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

export interface AsyncAgentEntry {
  agentId: string;
  description: string;
  status: AsyncAgentStatus;
  startedAt: number;
  finishedAt?: number;
  result?: string;
  error?: string;
  abort: () => void;
}

class AsyncAgentRegistry {
  private agents = new Map<string, AsyncAgentEntry>();

  register(entry: AsyncAgentEntry): void {
    this.agents.set(entry.agentId, entry);
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
  }

  markFailed(agentId: string, error: string): void {
    const e = this.agents.get(agentId);
    if (!e) return;
    if (e.status !== "running") return;
    e.status = "failed";
    e.error = error;
    e.finishedAt = Date.now();
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
  }
}

export const asyncAgentRegistry = new AsyncAgentRegistry();

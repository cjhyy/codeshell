/**
 * Agent coordinator — agent registry + message bus for multi-agent communication.
 */

/** A registered named agent. */
export interface AgentInfo {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  description: string;
  startedAt: number;
  completedAt?: number;
  result?: string;
}

/** A message between agents. */
export interface AgentMessage {
  from: string;
  to: string;
  content: string;
  timestamp: number;
}

/**
 * Singleton agent registry and message bus.
 */
class AgentCoordinator {
  private agents = new Map<string, AgentInfo>();
  private inbox = new Map<string, AgentMessage[]>();

  /** Register a named agent. */
  register(id: string, name: string, description: string): void {
    this.agents.set(name, {
      id,
      name,
      status: "running",
      description,
      startedAt: Date.now(),
    });
    if (!this.inbox.has(name)) {
      this.inbox.set(name, []);
    }
  }

  /** Mark an agent as completed. */
  complete(name: string, result?: string): void {
    const agent = this.agents.get(name);
    if (agent) {
      agent.status = "completed";
      agent.completedAt = Date.now();
      agent.result = result;
    }
  }

  /** Mark an agent as failed. */
  fail(name: string): void {
    const agent = this.agents.get(name);
    if (agent) {
      agent.status = "failed";
      agent.completedAt = Date.now();
    }
  }

  /** Get agent info by name. */
  get(name: string): AgentInfo | undefined {
    return this.agents.get(name);
  }

  /** List all agents. */
  list(): AgentInfo[] {
    return [...this.agents.values()];
  }

  /** List active (running) agents. */
  listActive(): AgentInfo[] {
    return [...this.agents.values()].filter((a) => a.status === "running");
  }

  /** Send a message to a named agent. */
  send(from: string, to: string, content: string): boolean {
    if (!this.agents.has(to)) return false;
    const messages = this.inbox.get(to) ?? [];
    messages.push({ from, to, content, timestamp: Date.now() });
    this.inbox.set(to, messages);
    return true;
  }

  /** Read messages for a named agent (drains the inbox). */
  receive(name: string): AgentMessage[] {
    const messages = this.inbox.get(name) ?? [];
    this.inbox.set(name, []);
    return messages;
  }

  /** Peek at messages without draining. */
  peek(name: string): AgentMessage[] {
    return this.inbox.get(name) ?? [];
  }

  /** Reset all state. */
  reset(): void {
    this.agents.clear();
    this.inbox.clear();
  }
}

export const agentCoordinator = new AgentCoordinator();

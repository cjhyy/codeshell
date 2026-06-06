import { describe, it, expect, beforeEach } from "bun:test";
import { agentStatusTool } from "./agent.js";
import { asyncAgentRegistry, type AsyncAgentEntry } from "./agent-registry.js";

function entry(over: Partial<AsyncAgentEntry>): AsyncAgentEntry {
  return {
    agentId: over.agentId ?? "a1",
    description: over.description ?? "desc",
    status: over.status ?? "running",
    startedAt: 0,
    abort: () => {},
    ...over,
  };
}

describe("agentStatusTool — session filtering", () => {
  beforeEach(() => asyncAgentRegistry.reset());

  it("lists only the current session's agents by default", async () => {
    asyncAgentRegistry.register(entry({ agentId: "mine", sessionId: "s1", description: "in session" }));
    asyncAgentRegistry.register(entry({ agentId: "theirs", sessionId: "s2", description: "other session" }));
    const out = await agentStatusTool({}, { sessionId: "s1" } as never);
    expect(out).toContain("mine");
    expect(out).not.toContain("theirs");
  });

  it("lists every session's agents when all=true", async () => {
    asyncAgentRegistry.register(entry({ agentId: "mine", sessionId: "s1" }));
    asyncAgentRegistry.register(entry({ agentId: "theirs", sessionId: "s2" }));
    const out = await agentStatusTool({ all: true }, { sessionId: "s1" } as never);
    expect(out).toContain("mine");
    expect(out).toContain("theirs");
  });

  it("falls back to process-wide when there is no session context", async () => {
    asyncAgentRegistry.register(entry({ agentId: "a1", sessionId: "s1" }));
    asyncAgentRegistry.register(entry({ agentId: "a2", sessionId: "s2" }));
    const out = await agentStatusTool({});
    expect(out).toContain("a1");
    expect(out).toContain("a2");
  });

  it("reports an empty session distinctly", async () => {
    asyncAgentRegistry.register(entry({ agentId: "theirs", sessionId: "s2" }));
    const out = await agentStatusTool({}, { sessionId: "s1" } as never);
    expect(out).toBe("No background agents in this session.");
  });

  it("a specific agent_id still resolves regardless of session", async () => {
    asyncAgentRegistry.register(entry({ agentId: "theirs", sessionId: "s2", status: "running" }));
    const out = await agentStatusTool({ agent_id: "theirs" }, { sessionId: "s1" } as never);
    expect(out).toContain("agent_id: theirs");
    expect(out).toContain("status:   running");
  });
});

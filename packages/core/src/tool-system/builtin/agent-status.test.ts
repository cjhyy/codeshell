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
    asyncAgentRegistry.register(
      entry({ agentId: "mine", sessionId: "s1", description: "in session" }),
    );
    asyncAgentRegistry.register(
      entry({ agentId: "theirs", sessionId: "s2", description: "other session" }),
    );
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

  it("rejects a specific agent_id outside the caller's direct tree", async () => {
    asyncAgentRegistry.register(entry({ agentId: "theirs", sessionId: "s2", status: "running" }));
    const out = await agentStatusTool({ agent_id: "theirs" }, { sessionId: "s1" } as never);
    expect(out).toMatch(/not found|not in this session/i);
  });

  it("returns the latest structured progress without copying transcript", async () => {
    asyncAgentRegistry.register(
      entry({
        agentId: "mine",
        sessionId: "s1",
        childSessionId: "child",
        progress: {
          phase: "tool",
          lastTool: { name: "Grep", state: "running" },
          tokens: { prompt: 12, completion: 3, total: 15 },
          summary: "正在运行 Grep",
          observedAt: 123,
        },
        transcript: [{ id: "secret", type: "assistant", text: "do not copy" }],
      }),
    );
    const out = await agentStatusTool({ agent_id: "mine" }, { sessionId: "s1" } as never);
    expect(out).toContain("phase:    tool");
    expect(out).toContain("正在运行 Grep");
    expect(out).toContain("tokens:   15");
    expect(out).not.toContain("do not copy");
  });
});

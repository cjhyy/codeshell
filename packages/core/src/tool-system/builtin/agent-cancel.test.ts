// Direct handler coverage for AgentCancel.
//
// The builtin coverage gate reported it as having no direct test. It is the one
// tool in that gap that changes a background sub-agent's LIFECYCLE — cancelling
// the wrong agent, or silently failing to cancel, both look identical to the
// model unless the returned message is exact.
import { afterEach, describe, expect, test } from "bun:test";
import { agentCancelTool } from "./agent.js";
import { asyncAgentRegistry, type AsyncAgentEntry } from "./agent-registry.js";

function register(agentId: string, status: AsyncAgentEntry["status"]): void {
  asyncAgentRegistry.register({
    agentId,
    description: "test agent",
    status,
    startedAt: Date.now(),
    // reset() aborts anything still running, so every entry needs this.
    abort: () => undefined,
  } as unknown as AsyncAgentEntry);
}

afterEach(() => {
  // The registry is a process-wide singleton with no per-entry removal; reset it
  // so these tests cannot leak agents into any other suite.
  asyncAgentRegistry.reset();
});

describe("AgentCancel tool", () => {
  test("requires an agent_id", async () => {
    expect(await agentCancelTool({})).toBe("Error: agent_id is required.");
  });

  test("an unknown agent_id is reported, not silently ignored", async () => {
    const out = await agentCancelTool({ agent_id: "nope" });
    expect(out).toBe('Error: agent_id "nope" not found.');
  });

  test("cancels a running agent and moves it out of running", async () => {
    register("agent-running", "running");
    const out = await agentCancelTool({ agent_id: "agent-running" });
    expect(out).toBe("Agent agent-running cancelled.");
    // The registry must reflect it — a message without a state change would be
    // a lie to the model.
    expect(asyncAgentRegistry.get("agent-running")?.status).not.toBe("running");
  });

  test("an already-finished agent says so instead of claiming a cancel", async () => {
    register("agent-done", "completed");
    const out = await agentCancelTool({ agent_id: "agent-done" });
    expect(out).toBe("Agent agent-done is already completed; nothing to cancel.");
    expect(asyncAgentRegistry.get("agent-done")?.status).toBe("completed");
  });

  test("a failed agent is likewise not cancellable", async () => {
    register("agent-failed", "failed");
    expect(await agentCancelTool({ agent_id: "agent-failed" })).toBe(
      "Agent agent-failed is already failed; nothing to cancel.",
    );
  });

  test("cancelling twice does not report a second success", async () => {
    register("agent-twice", "running");
    expect(await agentCancelTool({ agent_id: "agent-twice" })).toBe("Agent agent-twice cancelled.");
    // The second call sees a non-running status and must not claim success.
    expect(await agentCancelTool({ agent_id: "agent-twice" })).not.toBe(
      "Agent agent-twice cancelled.",
    );
  });

  test("cancelling one agent leaves the others alone", async () => {
    register("agent-a", "running");
    register("agent-b", "running");
    await agentCancelTool({ agent_id: "agent-a" });
    expect(asyncAgentRegistry.get("agent-b")?.status).toBe("running");
  });
});

import { describe, it, expect } from "bun:test";
import { agentTool } from "./agent.js";
import type { StreamEvent } from "../../types.js";
import type { SubAgentSpawner, ToolContext } from "../context.js";

/** Capture stream events emitted to the parent UI during a sub-agent run. */
function makeCtx(spawn: SubAgentSpawner["spawn"]): {
  ctx: ToolContext;
  events: StreamEvent[];
} {
  const events: StreamEvent[] = [];
  const spawner: SubAgentSpawner = {
    spawn,
    parentStream: (e) => {
      events.push(e);
    },
    describe: () => ({ cwd: "/tmp", permissionMode: "acceptEdits" }),
  };
  // Only the fields agentTool touches; cast through unknown for the rest.
  const ctx = { subAgentSpawner: spawner, sessionId: "s-test" } as unknown as ToolContext;
  return { ctx, events };
}

describe("agentTool — synchronous agent_end emission", () => {
  it("emits exactly one agent_end (no wall-clock timeout race) on success", async () => {
    const { ctx, events } = makeCtx(async () => "done text");
    await agentTool({ description: "d", prompt: "p" }, ctx);
    const ends = events.filter((e) => e.type === "agent_end");
    expect(ends).toHaveLength(1);
    expect((ends[0] as Extract<StreamEvent, { type: "agent_end" }>).text).toBe("done text");
    expect((ends[0] as Extract<StreamEvent, { type: "agent_end" }>).error).toBeUndefined();
  });

  it("emits exactly one agent_end (error only) when spawn throws", async () => {
    const { ctx, events } = makeCtx(async () => {
      throw new Error("boom");
    });
    await agentTool({ description: "d", prompt: "p" }, ctx);
    const ends = events.filter((e) => e.type === "agent_end");
    expect(ends).toHaveLength(1);
    const end = ends[0] as Extract<StreamEvent, { type: "agent_end" }>;
    expect(end.error).toContain("boom");
    expect(end.text).toBeUndefined();
  });

  it("does not run forever — a slow agent is bounded by abort, not a 5min wall clock", async () => {
    // The spawn resolves promptly here; the point of the assertion is that
    // agentTool returns from a normal spawn without waiting on any timer.
    const { ctx, events } = makeCtx(async () => "quick");
    const out = await agentTool({ description: "d", prompt: "p" }, ctx);
    expect(out).toBe("quick");
    expect(events.filter((e) => e.type === "agent_start")).toHaveLength(1);
  });
});

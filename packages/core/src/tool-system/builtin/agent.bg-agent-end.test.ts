import { describe, it, expect } from "bun:test";
import { agentTool } from "./agent.js";
import type { StreamEvent } from "../../types.js";
import type { SubAgentSpawner, ToolContext } from "../context.js";

/**
 * Direct-background agents (`run_in_background: true`) fire-and-forget the
 * sub-agent run. On SUCCESS runSubAgent emits its own agent_end; on
 * FAILURE / CANCEL it throws before that emit, so the .catch handler must emit
 * the terminal agent_end itself — otherwise the parent-feed card started by
 * agent_start never seals and the TUI spins forever.
 */
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
  const ctx = { subAgentSpawner: spawner, sessionId: "s-test" } as unknown as ToolContext;
  return { ctx, events };
}

/** Poll until the predicate holds or a short deadline passes (bg run is detached). */
async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!pred() && Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("agentTool — background agent_end on fail/cancel", () => {
  it("emits a terminal agent_end{error} when a background agent's spawn throws", async () => {
    const { ctx, events } = makeCtx(async () => {
      throw new Error("bg-boom");
    });

    await agentTool({ description: "d", prompt: "p", run_in_background: true }, ctx);
    await waitFor(() => events.some((e) => e.type === "agent_end"));

    const ends = events.filter((e) => e.type === "agent_end");
    expect(ends).toHaveLength(1);
    const end = ends[0] as Extract<StreamEvent, { type: "agent_end" }>;
    expect(end.error).toContain("bg-boom");
    // The start marker fired, so without a matching end the card would hang.
    expect(events.filter((e) => e.type === "agent_start")).toHaveLength(1);
  });

  it("emits a terminal agent_end when a background agent is aborted", async () => {
    const { ctx, events } = makeCtx(async (req) => {
      // Simulate a cancel: reject with an abort-style error while the run's
      // controller.signal is aborted. AgentCancel aborts the controller, which
      // makes the spawn reject; the .catch cancel branch must still seal the UI.
      await new Promise((r) => setTimeout(r, 10));
      const err = new Error("aborted");
      throw err;
      void req;
    });

    await agentTool({ description: "d", prompt: "p", run_in_background: true }, ctx);
    await waitFor(() => events.some((e) => e.type === "agent_end"));

    const ends = events.filter((e) => e.type === "agent_end");
    expect(ends.length).toBeGreaterThanOrEqual(1);
    expect(events.filter((e) => e.type === "agent_start")).toHaveLength(1);
  });
});

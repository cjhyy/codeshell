import { describe, it, expect } from "bun:test";
import { HookRegistry } from "../packages/core/src/hooks/registry.js";

// `notification` is fired void from agent.ts when a background sub-agent
// terminates. Wiring it end-to-end requires the full subAgentSpawner +
// nanoid + agent-registry path, which is exercised by the agent.ts integration
// tests. These tests pin the contract handlers will register against: the
// three terminal kinds, and the data envelope each carries.
describe("notification hook contract", () => {
  it("handlers can dispatch on kind to react only to completion", async () => {
    const hooks = new HookRegistry();
    let lastCompleted: string | undefined;
    hooks.register("notification", (ctx) => {
      if (ctx.data.kind === "agent_completed") {
        lastCompleted = ctx.data.finalText as string;
      }
      return {};
    });

    await hooks.emit("notification", {
      kind: "agent_completed",
      agentId: "a1",
      name: "fact-checker",
      description: "verify the claim",
      finalText: "The claim is correct.",
    });
    expect(lastCompleted).toBe("The claim is correct.");

    await hooks.emit("notification", {
      kind: "agent_failed",
      agentId: "a2",
      name: "fact-checker",
      description: "verify another",
      error: "network",
    });
    // completed slot unchanged after a failed event
    expect(lastCompleted).toBe("The claim is correct.");
  });

  it("all three terminal kinds reach the handler", async () => {
    const hooks = new HookRegistry();
    const kinds: string[] = [];
    hooks.register("notification", (ctx) => {
      kinds.push(ctx.data.kind as string);
      return {};
    });

    await hooks.emit("notification", { kind: "agent_completed", agentId: "a1" });
    await hooks.emit("notification", { kind: "agent_failed", agentId: "a2", error: "x" });
    await hooks.emit("notification", { kind: "agent_cancelled", agentId: "a3" });

    expect(kinds).toEqual([
      "agent_completed",
      "agent_failed",
      "agent_cancelled",
    ]);
  });

  it("handler errors do not propagate (notification is fire-and-forget)", async () => {
    const hooks = new HookRegistry();
    hooks.register("notification", () => {
      throw new Error("desktop notification daemon offline");
    });

    // emit must not throw; HookRegistry catches handler errors.
    await expect(
      hooks.emit("notification", { kind: "agent_completed", agentId: "a1" }),
    ).resolves.toEqual({});
  });
});

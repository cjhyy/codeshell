import { describe, expect, it } from "bun:test";
import { HookRegistry } from "./registry.js";

describe("HookRegistry identity", () => {
  it("merges the emitter's identity into every event, letting explicit data win", async () => {
    const registry = new HookRegistry();
    let identity: Record<string, unknown> | undefined = {
      sessionId: "s-1",
      preset: "mimi",
      isSubAgent: false,
    };
    registry.setIdentity(() => identity);
    const seen: Record<string, unknown>[] = [];
    registry.register("pre_tool_use", (ctx) => {
      seen.push(ctx.data);
      return {};
    });
    await registry.emit("pre_tool_use", { toolName: "Read" });
    await registry.emit("pre_tool_use", { toolName: "Read", sessionId: "explicit" });
    identity = undefined;
    await registry.emit("pre_tool_use", { toolName: "Write" });
    expect(seen).toEqual([
      { sessionId: "s-1", preset: "mimi", isSubAgent: false, toolName: "Read" },
      { sessionId: "explicit", preset: "mimi", isSubAgent: false, toolName: "Read" },
      { toolName: "Write" },
    ]);
  });
});

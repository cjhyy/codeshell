import { describe, expect, it } from "bun:test";
import { ToolExecutor } from "./executor.js";
import { ToolRegistry } from "./registry.js";
import { PermissionClassifier } from "./permission.js";
import { HookRegistry } from "../hooks/registry.js";
import type { ToolCall } from "../types.js";

function setup() {
  const registry = new ToolRegistry({ builtinTools: [] });
  let handlerRan = false;
  registry.registerTool(
    {
      name: "complete_goal",
      description: "fake complete_goal for visibility guard test",
      inputSchema: { type: "object", properties: {}, required: [] },
      source: "builtin",
      permissionDefault: "allow",
    },
    async () => {
      handlerRan = true;
      return "goal complete";
    },
  );

  const permission = new PermissionClassifier([], "bypassPermissions");
  const executor = new ToolExecutor(registry, permission, new HookRegistry());
  executor.setContext({ cwd: "/x", toolVisibility: { cwd: "/x", hasGoal: false } } as never);
  return { executor, ranHandler: () => handlerRan };
}

describe("ToolExecutor visibility guards", () => {
  it("rejects a builtin hidden by its visibility guard and never runs the handler", async () => {
    const { executor, ranHandler } = setup();
    const result = await executor.executeSingle({
      id: "c1",
      toolName: "complete_goal",
      args: {},
    } satisfies ToolCall);

    expect(result.isError).toBe(true);
    expect(result.error ?? "").toMatch(/not available/i);
    expect(ranHandler()).toBe(false);
  });
});

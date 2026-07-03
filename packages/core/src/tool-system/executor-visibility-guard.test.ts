import { describe, expect, it } from "bun:test";
import { ToolExecutor } from "./executor.js";
import { ToolRegistry } from "./registry.js";
import { PermissionClassifier } from "./permission.js";
import { HookRegistry } from "../hooks/registry.js";
import type { ToolCall } from "../types.js";

function setup(toolVisibility?: { cwd: string; hasGoal: boolean }) {
  const registry = new ToolRegistry({ builtinTools: [] });
  const ran: string[] = [];
  for (const name of ["complete_goal", "cancel_goal"]) {
    registry.registerTool(
      {
        name,
        description: `fake ${name} for goal-control runtime gate test`,
        inputSchema: { type: "object", properties: {}, required: [] },
        source: "builtin",
        permissionDefault: "allow",
      },
      async () => {
        ran.push(name);
        return `${name} ran`;
      },
    );
  }

  const permission = new PermissionClassifier([], "bypassPermissions");
  const executor = new ToolExecutor(registry, permission, new HookRegistry());
  executor.setContext({ cwd: "/x", toolVisibility } as never);
  return { executor, ranHandler: (name: string) => ran.includes(name) };
}

function call(toolName: "complete_goal" | "cancel_goal", args: Record<string, unknown> = {}): ToolCall {
  return { id: `${toolName}-1`, toolName, args };
}

describe("ToolExecutor goal-control runtime gate", () => {
  it("rejects complete_goal when no active goal is present and never runs the handler", async () => {
    const { executor, ranHandler } = setup({ cwd: "/x", hasGoal: false });
    const result = await executor.executeSingle(call("complete_goal"));

    expect(result.isError).toBe(true);
    expect(result.error ?? "").toMatch(/active goal/i);
    expect(ranHandler("complete_goal")).toBe(false);
  });

  it("rejects cancel_goal even with confirm=true when no active goal is present", async () => {
    const { executor, ranHandler } = setup({ cwd: "/x", hasGoal: false });
    const result = await executor.executeSingle(
      call("cancel_goal", { confirm: true, reason: "user said stop" }),
    );

    expect(result.isError).toBe(true);
    expect(result.error ?? "").toMatch(/active goal/i);
    expect(ranHandler("cancel_goal")).toBe(false);
  });

  it("rejects goal-control tools when runtime goal context is missing", async () => {
    const { executor, ranHandler } = setup(undefined);
    const result = await executor.executeSingle(call("complete_goal"));

    expect(result.isError).toBe(true);
    expect(ranHandler("complete_goal")).toBe(false);
  });

  it("allows goal-control handlers to run when an active goal is present", async () => {
    const { executor, ranHandler } = setup({ cwd: "/x", hasGoal: true });
    const result = await executor.executeSingle(call("complete_goal"));

    expect(result.isError).toBeFalsy();
    expect(result.result).toContain("complete_goal ran");
    expect(ranHandler("complete_goal")).toBe(true);
  });
});

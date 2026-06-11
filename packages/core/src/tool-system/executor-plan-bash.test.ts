import { describe, it, expect } from "bun:test";
import { ToolExecutor } from "./executor.js";
import { ToolRegistry } from "./registry.js";
import { PermissionClassifier } from "./permission.js";
import { HookRegistry } from "../hooks/registry.js";
import type { ToolCall } from "../types.js";

/**
 * Plan mode is read-only. Bash sits in PLAN_MODE_ALLOWED_TOOLS so the model can
 * SEE it for read-only probing — but allow-list membership must NOT, on its own,
 * grant write access. A write command (echo >, sed -i, mv, …) has to be blocked
 * in the executor's plan-mode gate; otherwise it slips into the normal
 * permission flow (user could approve it) AND leaves no diff, since it never
 * touches Write/Edit. Regression guard for that gate.
 */
describe("ToolExecutor plan-mode Bash gate", () => {
  function setup() {
    const registry = new ToolRegistry({ builtinTools: [] });
    let handlerRan = false;
    registry.registerTool(
      {
        name: "Bash",
        description: "fake bash for the plan-mode gate test",
        inputSchema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
        source: "builtin",
        permissionDefault: "allow",
      },
      async () => {
        handlerRan = true;
        return "ran";
      },
    );

    const permission = new PermissionClassifier([], "bypassPermissions");
    const executor = new ToolExecutor(registry, permission, new HookRegistry());
    executor.setContext({ planMode: true } as never);
    return { executor, ranHandler: () => handlerRan };
  }

  function bashCall(command: string): ToolCall {
    return { id: "c1", toolName: "Bash", args: { command } };
  }

  it("allows a read-only Bash command (ls)", async () => {
    const { executor, ranHandler } = setup();
    const result = await executor.executeSingle(bashCall("ls -la"));
    expect(result.isError).toBeFalsy();
    expect(ranHandler()).toBe(true);
  });

  it("blocks a redirect write (echo > file) and never runs the handler", async () => {
    const { executor, ranHandler } = setup();
    const result = await executor.executeSingle(bashCall("echo x > foo.txt"));
    expect(result.isError).toBe(true);
    expect(result.error ?? "").toMatch(/read-only/i);
    expect(result.error ?? "").toMatch(/ExitPlanMode/);
    expect(ranHandler()).toBe(false);
  });

  it("blocks an in-place edit (sed -i)", async () => {
    const { executor, ranHandler } = setup();
    const result = await executor.executeSingle(bashCall("sed -i 's/a/b/' foo.txt"));
    expect(result.isError).toBe(true);
    expect(ranHandler()).toBe(false);
  });
});

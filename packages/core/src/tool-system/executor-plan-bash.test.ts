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

  // #1 regression: the prior hand-rolled isReadOnlyBashCommand whitelisted
  // `find` and `awk` wholesale and missed process substitution / difftool,
  // so these file-mutating commands ran silently while planning. The gate
  // now defers to classifyBashCommand and only admits safe-read.
  it("blocks find -delete (mutating find)", async () => {
    const { executor, ranHandler } = setup();
    const result = await executor.executeSingle(bashCall("find . -name '*.log' -delete"));
    expect(result.isError).toBe(true);
    expect(ranHandler()).toBe(false);
  });

  it("blocks find -exec rm", async () => {
    const { executor, ranHandler } = setup();
    const result = await executor.executeSingle(bashCall("find . -name '*.tmp' -exec rm {} +"));
    expect(result.isError).toBe(true);
    expect(ranHandler()).toBe(false);
  });

  it("blocks awk system() shell-out", async () => {
    const { executor, ranHandler } = setup();
    const result = await executor.executeSingle(bashCall("awk 'BEGIN{system(\"rm -rf build\")}'"));
    expect(result.isError).toBe(true);
    expect(ranHandler()).toBe(false);
  });

  it("blocks process substitution (cat <(sh -c ...))", async () => {
    const { executor, ranHandler } = setup();
    const result = await executor.executeSingle(bashCall("cat <(sh -c 'touch evil')"));
    expect(result.isError).toBe(true);
    expect(ranHandler()).toBe(false);
  });

  it("blocks git difftool -x arbitrary command", async () => {
    const { executor, ranHandler } = setup();
    const result = await executor.executeSingle(bashCall("git difftool -x 'touch evil' HEAD"));
    expect(result.isError).toBe(true);
    expect(ranHandler()).toBe(false);
  });

  // Plan mode is strictly read-only: even non-destructive writes (mkdir/touch/cp)
  // must be blocked while planning — they belong after ExitPlanMode.
  it("blocks a safe-write command (mkdir) in plan mode", async () => {
    const { executor, ranHandler } = setup();
    const result = await executor.executeSingle(bashCall("mkdir newdir"));
    expect(result.isError).toBe(true);
    expect(ranHandler()).toBe(false);
  });

  it("still allows legit read-only find (no mutating action)", async () => {
    const { executor, ranHandler } = setup();
    const result = await executor.executeSingle(bashCall("find . -name '*.ts'"));
    expect(result.isError).toBeFalsy();
    expect(ranHandler()).toBe(true);
  });

  it("still allows a read-only pipe (ls | grep)", async () => {
    const { executor, ranHandler } = setup();
    const result = await executor.executeSingle(bashCall("ls | grep foo"));
    expect(result.isError).toBeFalsy();
    expect(ranHandler()).toBe(true);
  });
});

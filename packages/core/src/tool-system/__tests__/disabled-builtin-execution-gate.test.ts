import { describe, it, expect } from "bun:test";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { PermissionClassifier } from "../permission.js";
import { HookRegistry } from "../../hooks/registry.js";
import { HeadlessApprovalBackend } from "../permission.js";
import type { ToolContext } from "../context.js";

/**
 * Tightening B: a builtin marked `off` by a project capability override is
 * HIDDEN from the LLM's tool list (engine.ts applyBuiltinOverrideVisibility),
 * but the tool stays in the registry. The model can still NAME it
 * (hallucination, or remembered from an earlier turn when it was visible), so
 * `off` must be a real EXECUTION gate, not just prompt visibility. The executor
 * reads ctx.disabledBuiltins and rejects such a call WITHOUT running the
 * handler — mirroring how plan mode rejects a disallowed tool.
 */
function buildExecutor(): {
  exec: ToolExecutor;
  registry: ToolRegistry;
  ran: { value: boolean };
} {
  // Empty builtin set keeps the registry tiny; we register our own tool.
  const registry = new ToolRegistry({ builtinTools: [] });
  const ran = { value: false };
  registry.registerTool(
    {
      name: "DangerTool",
      description: "test tool",
      inputSchema: { type: "object", properties: {} },
    } as any,
    async () => {
      ran.value = true;
      return { id: "x", toolName: "DangerTool", result: "ran!" } as any;
    },
  );
  const permission = new PermissionClassifier(
    [],
    "default",
    new HeadlessApprovalBackend("approve-all"),
  );
  const exec = new ToolExecutor(registry, permission, new HookRegistry());
  return { exec, registry, ran };
}

describe("executor enforces builtin `off` at execution time", () => {
  it("rejects a call to a disabled builtin and does NOT run its handler", async () => {
    const { exec, ran } = buildExecutor();
    const ctx: ToolContext = {
      cwd: process.cwd(),
      planMode: false,
      disabledBuiltins: new Set(["DangerTool"]),
    } as any;
    exec.setContext(ctx);

    const result = await exec.executeSingle({
      id: "call-1",
      toolName: "DangerTool",
      args: {},
    });

    expect(result.isError).toBe(true);
    expect(result.error).toContain("disabled by this project's capability override");
    // The tool is still in the registry but the handler must NOT have executed.
    expect(ran.value).toBe(false);
  });

  it("runs the tool normally when it is NOT in the disabled set", async () => {
    const { exec, ran } = buildExecutor();
    const ctx: ToolContext = {
      cwd: process.cwd(),
      planMode: false,
      disabledBuiltins: new Set(["SomeOtherTool"]),
    } as any;
    exec.setContext(ctx);

    const result = await exec.executeSingle({
      id: "call-2",
      toolName: "DangerTool",
      args: {},
    });

    expect(result.isError).toBeUndefined();
    expect(ran.value).toBe(true);
  });

  it("runs normally when no disabled set is present (no override)", async () => {
    const { exec, ran } = buildExecutor();
    const ctx: ToolContext = {
      cwd: process.cwd(),
      planMode: false,
    } as any;
    exec.setContext(ctx);

    const result = await exec.executeSingle({
      id: "call-3",
      toolName: "DangerTool",
      args: {},
    });

    expect(result.isError).toBeUndefined();
    expect(ran.value).toBe(true);
  });
});

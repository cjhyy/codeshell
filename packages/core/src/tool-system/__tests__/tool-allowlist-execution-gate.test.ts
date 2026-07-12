import { describe, expect, it } from "bun:test";

import { HookRegistry } from "../../hooks/registry.js";
import type { ToolContext } from "../context.js";
import { ToolExecutor } from "../executor.js";
import { HeadlessApprovalBackend, PermissionClassifier } from "../permission.js";
import { ToolRegistry } from "../registry.js";

describe("executor run-scoped tool allowlist", () => {
  it("rejects a hidden Agent call without invoking the registered handler", async () => {
    const registry = new ToolRegistry({ builtinTools: [] });
    let ran = false;
    registry.registerTool(
      {
        name: "Agent",
        description: "test sub-agent tool",
        inputSchema: { type: "object", properties: {} },
      } as any,
      async () => {
        ran = true;
        return "spawned";
      },
    );
    const executor = new ToolExecutor(
      registry,
      new PermissionClassifier([], "bypassPermissions", new HeadlessApprovalBackend("approve-all")),
      new HookRegistry(),
    );
    executor.setContext({
      cwd: process.cwd(),
      planMode: false,
      toolAllowlist: new Set(["Read", "Glob", "Grep"]),
    } as unknown as ToolContext);

    const result = await executor.executeSingle({ id: "agent-call", toolName: "Agent", args: {} });

    expect(result.isError).toBe(true);
    expect(result.error).toContain("not available in this run");
    expect(ran).toBe(false);
  });
});

import { describe, expect, it, mock } from "bun:test";

import { HookRegistry } from "../../hooks/registry.js";
import type { ToolContext } from "../context.js";
import { ToolExecutor } from "../executor.js";
import { HeadlessApprovalBackend, PermissionClassifier } from "../permission.js";
import { ToolRegistry } from "../registry.js";

describe("executor run-scoped tool allowlist", () => {
  it("rejects every representative mutating/delegating/MCP call without invoking handlers", async () => {
    const registry = new ToolRegistry({ builtinTools: [] });
    const blockedTools = [
      "Write",
      "Edit",
      "ApplyPatch",
      "Bash",
      "Config",
      "Agent",
      "Task",
      "MCPTool",
      "mcp__review_server_mutate",
    ];
    const handlers = new Map<string, ReturnType<typeof mock>>();
    for (const name of blockedTools) {
      const handler = mock(async () => `ran ${name}`);
      handlers.set(name, handler);
      registry.registerTool(
        {
          name,
          description: `test ${name} tool`,
          inputSchema: { type: "object", properties: {} },
        } as any,
        handler,
      );
    }
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

    for (const toolName of blockedTools) {
      const result = await executor.executeSingle({
        id: `blocked-${toolName}`,
        toolName,
        args: {},
      });
      expect(result.isError).toBe(true);
      expect(result.error).toContain("not available in this run");
      expect(handlers.get(toolName)).toHaveBeenCalledTimes(0);
    }
  });
});

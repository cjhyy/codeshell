import { describe, expect, test } from "bun:test";
import { PermissionClassifier } from "./permission.js";
import { ToolExecutor } from "./executor.js";
import { ToolRegistry } from "./registry.js";
import { SENSITIVE_TOOL_RESULT_PLACEHOLDER } from "./tool-result-redaction.js";
import type { HookRegistry } from "../hooks/registry.js";

describe("ToolExecutor sensitive ToolResult handling", () => {
  test("redacts hook payloads while preserving model-facing result", async () => {
    const registry = new ToolRegistry({ builtinTools: [] });
    registry.registerTool(
      {
        name: "SecretTool",
        description: "test",
        inputSchema: { type: "object", additionalProperties: true },
        source: "builtin",
        permissionDefault: "allow",
        pathPolicyExempt: true,
      },
      async () => ({
        result: "secret-token",
        sensitive: true,
        displayResult: SENSITIVE_TOOL_RESULT_PLACEHOLDER,
        transcriptResult: SENSITIVE_TOOL_RESULT_PLACEHOLDER,
      }),
    );

    const hookPayloads: Array<{ event: string; result?: unknown }> = [];
    const hooks = {
      async emit(event: string, data: Record<string, unknown>) {
        if (event === "on_tool_end" || event === "post_tool_use") {
          hookPayloads.push({ event, result: data.result });
        }
        return {};
      },
    } as unknown as HookRegistry;
    const executor = new ToolExecutor(
      registry,
      new PermissionClassifier([], "bypassPermissions"),
      hooks,
    );

    const result = await executor.executeSingle({
      id: "call-1",
      toolName: "SecretTool",
      args: {},
    });

    expect(result.result).toBe("secret-token");
    expect(hookPayloads).toEqual([
      { event: "on_tool_end", result: SENSITIVE_TOOL_RESULT_PLACEHOLDER },
      { event: "post_tool_use", result: SENSITIVE_TOOL_RESULT_PLACEHOLDER },
    ]);
  });
});

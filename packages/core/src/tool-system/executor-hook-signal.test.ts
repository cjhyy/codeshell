import { describe, expect, it } from "bun:test";
import { HookRegistry } from "../hooks/registry.js";
import type { HookEventName } from "../hooks/events.js";
import { ToolExecutor } from "./executor.js";
import { PermissionClassifier } from "./permission.js";
import { ToolRegistry } from "./registry.js";

describe("ToolExecutor hook abort propagation", () => {
  it("adds the run signal to every tool-stage hook payload", async () => {
    const registry = new ToolRegistry({ builtinTools: [] });
    registry.registerTool(
      {
        name: "Write",
        description: "hook signal probe",
        inputSchema: {
          type: "object",
          properties: { file_path: { type: "string" } },
          required: ["file_path"],
        },
        source: "builtin",
        permissionDefault: "allow",
      },
      async () => ({ ok: true, result: "ok" }),
    );
    const hooks = new HookRegistry();
    const events: HookEventName[] = [
      "pre_tool_use",
      "on_permission_check",
      "on_tool_start",
      "on_tool_end",
      "post_tool_use",
      "file_changed",
    ];
    const seen = new Map<HookEventName, unknown>();
    for (const event of events) {
      hooks.register(event, (ctx) => {
        seen.set(event, ctx.data.signal);
        return {};
      });
    }
    const executor = new ToolExecutor(
      registry,
      new PermissionClassifier([], "bypassPermissions"),
      hooks,
    );
    const controller = new AbortController();
    executor.setSignal(controller.signal);

    const result = await executor.executeSingle({
      id: "write-signal",
      toolName: "Write",
      args: { file_path: "out.txt" },
    });

    expect(result.isError).toBe(false);
    for (const event of events) expect(seen.get(event)).toBe(controller.signal);
  });
});

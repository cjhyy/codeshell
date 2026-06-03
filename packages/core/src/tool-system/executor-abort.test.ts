import { describe, it, expect } from "bun:test";
import { ToolExecutor } from "./executor.js";
import { ToolRegistry } from "./registry.js";
import { PermissionClassifier } from "./permission.js";
import { HookRegistry } from "../hooks/registry.js";
import type { ToolCall } from "../types.js";

/**
 * Abort-propagation test for the sub-agent leak fix (step 2).
 *
 * When the executor's signal is already aborted, executeSingle must
 * short-circuit at the TOP — returning an aborted error result without
 * running the pre_tool_use hook, the permission classifier, or the tool
 * handler. This is what makes an aborted tool batch (e.g. 10 queued Reads in
 * a child sub-agent) collapse instantly instead of each call paying for the
 * full hook/permission round-trip before registry.executeTool bails.
 */
describe("ToolExecutor abort propagation", () => {
  function setup() {
    const registry = new ToolRegistry({ builtinTools: [] });
    let handlerRan = false;
    registry.registerTool(
      {
        name: "Probe",
        description: "test probe",
        inputSchema: { type: "object", properties: {} },
      },
      async () => {
        handlerRan = true;
        return "ran";
      },
    );

    let preToolUseFired = false;
    const hooks = new HookRegistry();
    hooks.register("pre_tool_use", async () => {
      preToolUseFired = true;
      return {};
    });

    const permission = new PermissionClassifier([], "bypassPermissions");
    const executor = new ToolExecutor(registry, permission, hooks);
    return {
      executor,
      ranHandler: () => handlerRan,
      preToolUseFired: () => preToolUseFired,
    };
  }

  const call: ToolCall = { id: "c1", toolName: "Probe", args: {} };

  it("returns an aborted error result without running the handler or pre_tool_use hook", async () => {
    const { executor, ranHandler, preToolUseFired } = setup();
    const controller = new AbortController();
    controller.abort();
    executor.setSignal(controller.signal);

    const result = await executor.executeSingle(call);

    expect(result.isError).toBe(true);
    expect(result.error ?? "").toMatch(/abort/i);
    expect(ranHandler()).toBe(false);
    expect(preToolUseFired()).toBe(false);
  });

  it("runs normally when the signal is not aborted", async () => {
    const { executor, ranHandler } = setup();
    const controller = new AbortController();
    executor.setSignal(controller.signal);

    const result = await executor.executeSingle(call);

    expect(result.isError).toBeFalsy();
    expect(result.result).toBe("ran");
    expect(ranHandler()).toBe(true);
  });
});

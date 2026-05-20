import { describe, it, expect } from "bun:test";
import { ToolRegistry } from "../src/tool-system/registry.js";
import { ToolExecutor } from "../src/tool-system/executor.js";
import { PermissionClassifier } from "../src/tool-system/permission.js";
import { HookRegistry } from "../src/hooks/registry.js";

// Covers the deny short-circuit at executor.ts:131 — pre_tool_use handlers
// returning {decision: "deny"} must prevent the underlying tool from running
// AND surface their `messages` back to the model in the error string so the
// LLM has enough context to recover (CC parity).
describe("pre_tool_use deny short-circuits the executor", () => {
  function setup() {
    const registry = new ToolRegistry({ builtinTools: ["Read"] });
    // "allow" rule so the deny under test is unambiguously coming from the
    // hook, not the permission classifier.
    const permission = new PermissionClassifier([
      { tool: "Read", decision: "allow" },
    ]);
    const hooks = new HookRegistry();
    const executor = new ToolExecutor(registry, permission, hooks);
    return { executor, hooks };
  }

  it("returns isError with the hook's deny message and never invokes the tool", async () => {
    const { executor, hooks } = setup();
    let toolRan = false;
    // Replace Read with a sentinel so we can detect if it ever runs. The
    // executor pulls executors via builtinExecutors; registerTool with a
    // second arg overwrites the entry for "Read".
    const registry2 = new ToolRegistry({ builtinTools: ["Read"] });
    registry2.registerTool(
      { name: "Read", description: "x", inputSchema: { type: "object" } },
      async () => {
        toolRan = true;
        return { id: "x", toolName: "Read", content: "should-not-run" };
      },
    );
    const exec = new ToolExecutor(
      registry2,
      new PermissionClassifier([{ tool: "Read", decision: "allow" }]),
      hooks,
    );

    hooks.register("pre_tool_use", () => ({
      decision: "deny",
      messages: ["sandbox policy violation: path outside cwd"],
    }));

    const result = await exec.executeSingle({
      id: "call-1",
      toolName: "Read",
      args: { file_path: "/tmp/x" },
    });

    expect(toolRan).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.error).toContain("Blocked by pre_tool_use hook");
    expect(result.error).toContain("sandbox policy violation");
  });

  it("falls back to a generic message when the deny handler omits messages", async () => {
    const { executor, hooks } = setup();
    hooks.register("pre_tool_use", () => ({ decision: "deny" }));

    const result = await executor.executeSingle({
      id: "call-2",
      toolName: "Read",
      args: { file_path: "/tmp/x" },
    });

    expect(result.isError).toBe(true);
    expect(result.error).toContain("Blocked by pre_tool_use hook");
    expect(result.error).toContain("denied");
  });

  it("a non-deny decision (allow) does not short-circuit the executor", async () => {
    const { hooks } = setup();
    let toolRan = false;
    const registry = new ToolRegistry({ builtinTools: ["Read"] });
    registry.registerTool(
      { name: "Read", description: "x", inputSchema: { type: "object" } },
      async () => {
        toolRan = true;
        return { id: "ok", toolName: "Read", content: "ran" };
      },
    );
    const exec = new ToolExecutor(
      registry,
      new PermissionClassifier([{ tool: "Read", decision: "allow" }]),
      hooks,
    );

    hooks.register("pre_tool_use", () => ({ decision: "allow" }));

    const result = await exec.executeSingle({
      id: "call-3",
      toolName: "Read",
      args: { file_path: "/tmp/x" },
    });

    expect(toolRan).toBe(true);
    expect(result.isError).toBeFalsy();
  });
});

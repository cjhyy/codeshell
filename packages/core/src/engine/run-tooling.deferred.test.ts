import { describe, expect, test } from "bun:test";
import { assembleRunToolDefs, initializeRunToolSurface } from "./run-tooling.js";
import { ToolRegistry } from "../tool-system/registry.js";
import { ToolExecutor } from "../tool-system/executor.js";
import { PermissionClassifier } from "../tool-system/permission.js";
import { HookRegistry } from "../hooks/registry.js";
import type { ToolContext } from "../tool-system/context.js";
import { toolSearchTool } from "../tool-system/builtin/tool-search.js";

function fixture(initial: readonly string[] | undefined = ["ToolSearch"], onApproval?: () => void) {
  const registry = new ToolRegistry({ builtinTools: ["ToolSearch"] });
  let executions = 0,
    approvals = 0,
    hookCalls = 0;
  registry.registerTool(
    {
      name: "DeferredAction",
      description: "Perform a fixture action",
      inputSchema: {
        type: "object",
        properties: { token: { type: "string", enum: ["SCHEMA_ONLY"] } },
      },
      source: "builtin",
      permissionDefault: "ask",
    },
    async () => {
      executions++;
      return "done";
    },
  );
  const ctx = { cwd: "/repo", toolRegistry: registry } as ToolContext;
  const hooks = new HookRegistry();
  hooks.register("pre_tool_use", async () => {
    hookCalls++;
    return {};
  });
  hooks.register("on_tool_start", async () => {
    hookCalls++;
    return {};
  });
  const executor = new ToolExecutor(
    registry,
    new PermissionClassifier([], "default", {
      requestApproval: async () => {
        approvals++;
        onApproval?.();
        return { approved: true };
      },
    }),
    hooks,
  );
  executor.setContext(ctx);
  let hidden = false;
  initializeRunToolSurface(ctx, initial, () => {
    const catalog = registry
      .getToolDefinitions()
      .filter((tool) => !hidden || tool.name !== "DeferredAction");
    ctx.searchableToolDefinitions = catalog;
    return catalog;
  });

  return {
    ctx,
    registry,
    executor,
    hide: () => {
      hidden = true;
    },
    counts: () => ({ executions, approvals, hookCalls }),
  };
}

describe("Run-local progressive tool surface", () => {
  test("removing the project override restores eligibility without a stale executor deny", () => {
    const f = fixture();
    const assemble = (builtinOverride?: Record<string, "off">) =>
      assembleRunToolDefs({
        toolRegistry: f.registry,
        toolCtx: f.ctx,
        guardCwd: "/repo",
        hasRunnableGoal: false,
        settingsScope: "isolated",
        builtinToolHost: undefined,
        isSubAgent: false,
        behaviorProfileId: undefined,
        profileMeta: undefined,
        builtinOverride,
        mcpServers: {},
        mcpDisabled: false,
        featureFlags: {},
        toolGuards: new Map(),
        toolRewriters: new Map(),
        toolFeatureFlags: new Map(),
        applyBuiltinOverrideVisibility: (tools, overrides) =>
          tools.filter((tool) => overrides?.[tool.name] !== "off"),
        profileAllowedToolNames: undefined,
        runPlanMode: false,
      });
    expect(assemble({ DeferredAction: "off" }).map((tool) => tool.name)).toEqual(["ToolSearch"]);
    expect(f.ctx.disabledBuiltins!.has("DeferredAction")).toBe(true);
    expect(assemble().map((tool) => tool.name)).toContain("DeferredAction");
    expect(f.ctx.disabledBuiltins).toBeUndefined();
  });
  test("capability revocation during approval blocks the handler without changing advertised schemas", async () => {
    const f = fixture(["DeferredAction"], () => f.hide());
    const advertised = f.ctx.refreshRunTools!();
    const result = await f.executor.executeSingle({
      id: "revoke-during-approval",
      toolName: "DeferredAction",
      args: {},
    });
    expect(result.error).toContain("no longer available");
    expect(f.counts()).toEqual({ executions: 0, approvals: 1, hookCalls: 2 });
    expect(advertised.map((tool) => tool.name)).toContain("DeferredAction");
    expect(f.ctx.modelToolNames!.has("DeferredAction")).toBe(true);
    expect(f.ctx.refreshRunTools!().map((tool) => tool.name)).not.toContain("DeferredAction");
  });
  test("keyword discovery is compact; selection only affects the next frozen model step", async () => {
    const f = fixture();
    const first = f.ctx.refreshRunTools!();
    expect(first.map((tool) => tool.name)).toEqual(["ToolSearch"]);
    const keyword = await toolSearchTool({ query: "fixture action" }, f.ctx);
    expect(keyword).toContain("DeferredAction");
    expect(keyword).not.toContain("SCHEMA_ONLY");
    expect(f.ctx.runToolSurface!.isSelected("DeferredAction")).toBe(false);
    const forged = () =>
      f.executor.executeSingle({ id: "forged", toolName: "DeferredAction", args: {} });
    expect((await forged()).error).toContain("not loaded");
    expect(f.counts()).toEqual({ executions: 0, approvals: 0, hookCalls: 0 });
    expect(await toolSearchTool({ query: "select:DeferredAction" }, f.ctx)).not.toContain(
      "SCHEMA_ONLY",
    );
    expect((await forged()).error).toContain("next model step");
    const next = f.ctx.refreshRunTools!();
    expect(next.map((tool) => tool.name)).toEqual(["ToolSearch", "DeferredAction"]);
    expect(JSON.stringify(next)).toContain("SCHEMA_ONLY");
    expect(first.map((tool) => tool.name)).toEqual(["ToolSearch"]);
    expect((await forged()).isError).toBe(false);
    expect(f.counts()).toEqual({ executions: 1, approvals: 1, hookCalls: 2 });
    await toolSearchTool({ query: "select:DeferredAction" }, f.ctx);
    expect(f.ctx.refreshRunTools!()).toEqual(next);
    expect(f.registry.getToolDefinitions()).toHaveLength(2);
  });

  test("revocation wins over selection and unknown names never reach approvals or hooks", async () => {
    const f = fixture();
    await toolSearchTool({ query: "select:DeferredAction" }, f.ctx);
    f.ctx.refreshRunTools!();
    f.hide();
    expect(f.ctx.refreshRunTools!().map((tool) => tool.name)).toEqual(["ToolSearch"]);
    for (const toolName of ["DeferredAction", "UnknownAction"]) {
      const result = await f.executor.executeSingle({ id: toolName, toolName, args: {} });
      expect(result.error).toContain("not available");
      expect(result.error).not.toContain("select:");
    }
    expect(f.counts()).toEqual({ executions: 0, approvals: 0, hookCalls: 0 });
  });

  test("eager compatibility and late tool discovery do not change registry ownership", async () => {
    const eager = fixture(undefined);
    // Passing undefined to fixture uses its default; explicitly initialize the eager host.
    initializeRunToolSurface(eager.ctx, undefined, () => eager.registry.getToolDefinitions());
    expect(eager.ctx.refreshRunTools!()).toHaveLength(2);
    const noSearch = fixture([]);
    noSearch.registry.unregisterTool("ToolSearch");
    initializeRunToolSurface(noSearch.ctx, [], () => noSearch.registry.getToolDefinitions());
    expect(noSearch.ctx.refreshRunTools!().map((tool) => tool.name)).toEqual(["DeferredAction"]);
    const f = fixture();
    f.ctx.refreshRunTools!();
    f.registry.registerTool(
      {
        name: "mcp_fixture_late",
        description: "Late fixture tool",
        inputSchema: {},
        source: "mcp",
        serverName: "fixture",
        permissionDefault: "ask",
      },
      async () => "late",
    );
    expect(f.ctx.refreshRunTools!().map((tool) => tool.name)).toEqual(["ToolSearch"]);
    expect(await toolSearchTool({ query: "select:mcp_fixture_late" }, f.ctx)).toContain(
      "mcp_fixture_late",
    );
    expect(f.ctx.refreshRunTools!().map((tool) => tool.name)).toEqual([
      "ToolSearch",
      "mcp_fixture_late",
    ]);
  });
});

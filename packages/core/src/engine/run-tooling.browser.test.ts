import { describe, expect, test } from "bun:test";
import { assembleRunToolDefs } from "./run-tooling.js";
import { ToolRegistry } from "../tool-system/registry.js";
import { BUILTIN_TOOL_GUARDS } from "../tool-system/builtin/index.js";
import type { ToolContext } from "../tool-system/context.js";
import { toolSearchTool } from "../tool-system/builtin/tool-search.js";
import { ToolExecutor } from "../tool-system/executor.js";
import { PermissionClassifier } from "../tool-system/permission.js";
import { HookRegistry } from "../hooks/registry.js";
import { buildPresetSystemPrompt, BUILTIN_AGENT_PRESETS } from "../preset/index.js";

const browserNames = ["browser_navigate", "browser_observe", "browser_act"];

function surface(browser?: ToolContext["browser"]) {
  const registry = new ToolRegistry({ builtinTools: [...browserNames, "ToolSearch"] }).fork();
  const toolCtx = { cwd: "/repo", toolRegistry: registry, browser } as ToolContext;
  const assemble = () =>
    assembleRunToolDefs({
      toolRegistry: registry,
      toolCtx,
      guardCwd: "/repo",
      hasRunnableGoal: false,
      settingsScope: "project",
      builtinToolHost: "desktop",
      isSubAgent: true,
      behaviorProfileId: undefined,
      profileMeta: undefined,
      builtinOverride: undefined,
      mcpServers: {},
      mcpDisabled: false,
      featureFlags: undefined,
      toolGuards: BUILTIN_TOOL_GUARDS,
      toolRewriters: new Map(),
      toolFeatureFlags: new Map(),
      applyBuiltinOverrideVisibility: (tools) => tools,
      profileAllowedToolNames: undefined,
      runPlanMode: false,
    });
  return { toolCtx, registry, assemble };
}

describe("browser host capability follows the actual run", () => {
  test("an unwired desktop child hides browser schemas, instructions, discovery, and execution", async () => {
    const { toolCtx, registry, assemble } = surface();
    const definitions = assemble();
    expect(definitions.map((tool) => tool.name)).toEqual(["ToolSearch"]);
    expect(
      buildPresetSystemPrompt(
        BUILTIN_AGENT_PRESETS.general,
        definitions.map((tool) => tool.name),
      ),
    ).not.toContain("## Browser automation");
    const search = await toolSearchTool({ query: "select:browser_navigate" }, toolCtx);
    expect(search).toContain("not available in the current Session context");
    const executor = new ToolExecutor(
      registry,
      new PermissionClassifier([], "default"),
      new HookRegistry(),
    );
    executor.setContext(toolCtx);
    const result = await executor.executeSingle({
      id: "remembered-browser",
      toolName: "browser_navigate",
      args: { url: "https://example.com" },
    });
    expect(result.isError).toBe(true);
    expect(result.error).toContain("not available");
  });

  test("wiring a child bridge exposes the native browser on the next turn and removing it hides it", async () => {
    const { toolCtx, assemble } = surface();
    assemble();
    toolCtx.browser = { navigate: async () => ({ ok: true }) } as ToolContext["browser"];
    expect(assemble().map((tool) => tool.name)).toEqual(expect.arrayContaining(browserNames));
    expect(await toolSearchTool({ query: "浏览器", max_results: 1 }, toolCtx)).toContain(
      "### browser_navigate",
    );
    delete toolCtx.browser;
    expect(assemble().map((tool) => tool.name)).toEqual(["ToolSearch"]);
    expect(await toolSearchTool({ query: "浏览器" }, toolCtx)).not.toContain("browser_navigate");
  });
});

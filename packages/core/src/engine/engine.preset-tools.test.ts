import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine.js";
import { EngineRuntime, type EngineRuntimeOptions } from "./runtime.js";
import { ModelPool } from "../llm/model-pool.js";
import { ToolRegistry } from "../tool-system/registry.js";
import { MCPManager } from "../tool-system/mcp-manager.js";
import { defaultSandboxConfig } from "../tool-system/sandbox/index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runtimeWithSeed(seed: ToolRegistry): EngineRuntime {
  return new EngineRuntime({
    modelPool: new ModelPool(),
    toolRegistry: seed,
    settings: {} as EngineRuntimeOptions["settings"],
    mcpPool: new MCPManager(seed),
    costTracker: {} as EngineRuntimeOptions["costTracker"],
  });
}

function engine(preset: string, runtime?: EngineRuntime): Engine {
  const dir = mkdtempSync(join(tmpdir(), "engine-preset-tools-"));
  dirs.push(dir);
  return new Engine({
    llm: { provider: "fake-preset-tools", model: "m", apiKey: "test" } as never,
    cwd: dir,
    sessionStorageDir: join(dir, "sessions"),
    headless: true,
    permissionMode: "bypassPermissions",
    settingsScope: "isolated",
    sandbox: defaultSandboxConfig("off"),
    preset,
    ...(runtime ? { runtime } : {}),
  });
}

const names = (target: Engine) =>
  target
    .getToolRegistry()
    .getToolDefinitions()
    .map((tool) => tool.name)
    .sort();

describe("per-Engine tool membership", () => {
  it("takes each Session's tools from its own preset, not the shared seed's", () => {
    const seedEngine = engine("general");
    const runtime = runtimeWithSeed(seedEngine.getRuntimeToolRegistry());
    const general = engine("general", runtime);
    const minimal = engine("harness-min", runtime);
    expect(names(general)).toEqual(names(engine("general")));
    expect(names(minimal)).toEqual(names(engine("harness-min")));
    expect(names(minimal).length).toBeLessThan(names(general).length);
  });

  it("never shares a registry instance between Sessions or with the seed", () => {
    const seed = new ToolRegistry({ builtinTools: [] });
    const runtime = runtimeWithSeed(seed);
    const first = engine("general", runtime);
    const second = engine("general", runtime);
    expect(first.getToolRegistry()).not.toBe(second.getToolRegistry());
    expect(first.getToolRegistry()).not.toBe(seed);
    expect(seed.getToolDefinitions()).toEqual([]);
  });

  it("rebuilds the tools when a reload changes the preset, keeping host tools", () => {
    const target = engine("general", runtimeWithSeed(new ToolRegistry({ builtinTools: [] })));
    target.registerCustomTool(
      {
        name: "HostProbe",
        description: "host tool",
        inputSchema: { type: "object", properties: {} },
        source: "builtin",
      } as never,
      async () => "ok",
    );
    const before = target.getToolRegistry();
    target.refreshRuntimeConfig({ preset: "harness-min" }, 1);
    expect(target.getToolRegistry()).not.toBe(before);
    expect(names(target)).toEqual([...names(engine("harness-min")), "HostProbe"].sort());
    expect(before.getToolDefinitions()).toEqual([]);
  });

  it("keeps the registry when a reload does not change the tool set", () => {
    const target = engine("general");
    const before = target.getToolRegistry();
    target.refreshRuntimeConfig({ preset: "general" }, 1);
    expect(target.getToolRegistry()).toBe(before);
  });
});

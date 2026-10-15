import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "../engine/engine.js";
import { compileComposition } from "../composition/compiler.js";
import { registerAlwaysTools } from "../composition/resolve-preset.js";
import type { AgentModule } from "../composition/types.js";
import { ToolRegistry } from "./registry.js";

const definition = (name: string) => ({
  name,
  description: name,
  inputSchema: { type: "object" as const, properties: {} },
  source: "builtin" as const,
  permissionDefault: "allow" as const,
});

describe("ToolRegistry default built-ins", () => {
  it("rejects reserved names at direct and MCP adapter registration", () => {
    const registry = new ToolRegistry({ builtinTools: [] });
    for (const name of ["__browser_action__", "__workspace_action__", "__ask_user__", "__custom"]) {
      for (const source of ["builtin", "mcp"] as const) {
        expect(() =>
          registry.registerTool({ ...definition(name), source }, async () => "ok"),
        ).toThrow("reserved for internal host requests");
        expect(registry.hasTool(name)).toBe(false);
      }
    }
  });

  it("rejects reserved catalog names even when the tool is not selected", () => {
    expect(
      () =>
        new ToolRegistry({
          builtinTools: [],
          toolCatalog: [
            {
              definition: definition("__credential_action__"),
              execute: async () => "ok",
              exposure: { presetTags: [] },
            },
          ],
        }),
    ).toThrow("reserved for internal host requests");
  });

  it("keeps Arena out of the default registry", () => {
    expect(new ToolRegistry().hasTool("Arena")).toBe(false);
  });

  it("rejects Arena as a core built-in", () => {
    expect(() => new ToolRegistry({ builtinTools: ["Arena"] })).toThrow(
      "Unknown built-in tool(s): Arena",
    );
  });

  it("forks independent mutable views", () => {
    const base = new ToolRegistry({ builtinTools: [] });
    const left = base.fork();
    const right = base.fork();
    left.registerTool(definition("Arena"), async () => "ok");
    expect(left.hasTool("Arena")).toBe(true);
    expect(right.hasTool("Arena")).toBe(false);
    expect(base.hasTool("Arena")).toBe(false);
  });

  it("preserves availability guards in engine-local forks", () => {
    const availability = () => false;
    const base = new ToolRegistry({
      toolCatalog: [
        {
          definition: definition("RouteBoundReply"),
          execute: async () => "should not run",
          exposure: { presetTags: [], availability },
        },
      ],
    });

    expect(base.getAvailabilityGuard("RouteBoundReply")).toBe(availability);
    expect(base.fork().getAvailabilityGuard("RouteBoundReply")).toBe(availability);
  });

  it("fails loud on duplicate module contributions and registry conflicts", () => {
    const registry = new ToolRegistry({ builtinTools: [] });
    const module = (id: string): AgentModule => ({ id });
    expect(() => compileComposition({ modules: [module("arena"), module("arena")] })).toThrow(
      "Duplicate module id",
    );
    expect(() =>
      compileComposition({
        modules: [
          { id: "left", protocol: { queries: { inspect: async () => 1 } } },
          { id: "right", protocol: { queries: { inspect: async () => 2 } } },
        ],
      }),
    ).toThrow('Duplicate query "inspect"');
    const alwaysTool = (name: string) => ({
      kind: "always" as const,
      tool: { definition: definition(name), execute: async () => 1 },
    });
    expect(() =>
      compileComposition({
        modules: [
          { id: "left-tool", engine: { tools: [alwaysTool("same")] } },
          { id: "right-tool", engine: { tools: [alwaysTool("same")] } },
        ],
      }),
    ).toThrow('Duplicate tool "same"');
    registry.registerTool(definition("existing"));
    const conflicting = compileComposition({
      modules: [{ id: "conflict", engine: { tools: [alwaysTool("existing")] } }],
    });
    expect(() => registerAlwaysTools(conflicting, registry)).toThrow(
      "conflicts with registered tool",
    );
  });

  it("keeps seed capabilities out of the registry exported to EngineRuntime", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-capability-isolation-"));
    try {
      const engine = new Engine({
        llm: { provider: "openai", model: "test", apiKey: "test" },
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        modules: [
          {
            id: "arena",
            engine: {
              tools: [
                {
                  kind: "always" as const,
                  tool: { definition: definition("Arena"), execute: async () => "ok" },
                },
              ],
            },
          },
        ],
      });
      expect(engine.getToolRegistry().hasTool("Arena")).toBe(true);
      expect(engine.getRuntimeToolRegistry().hasTool("Arena")).toBe(false);
      expect(() =>
        engine.registerCustomTool(definition("__panel_action__"), async () => "ok"),
      ).toThrow("reserved for internal host requests");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

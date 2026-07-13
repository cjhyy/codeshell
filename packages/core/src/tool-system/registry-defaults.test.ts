import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "../engine/engine.js";
import type { CapabilityModule } from "./capability-module.js";
import { registerCapabilityModules } from "./capability-module.js";
import { ToolRegistry } from "./registry.js";

const definition = (name: string) => ({
  name,
  description: name,
  inputSchema: { type: "object" as const, properties: {} },
  source: "builtin" as const,
  permissionDefault: "allow" as const,
});

describe("ToolRegistry default built-ins", () => {
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

  it("fails loud on duplicate capability names", () => {
    const registry = new ToolRegistry({ builtinTools: [] });
    const module = (id: string): CapabilityModule => ({ id, tools: [] });
    expect(() => registerCapabilityModules(registry, [module("arena"), module("arena")])).toThrow(
      "Duplicate capability module id",
    );
    expect(() =>
      registerCapabilityModules(registry, [
        { id: "left", queries: { inspect: async () => 1 } },
        { id: "right", queries: { inspect: async () => 2 } },
      ]),
    ).toThrow("Duplicate capability query");
    expect(() =>
      registerCapabilityModules(registry, [
        { id: "left-tool", tools: [{ definition: definition("same"), execute: async () => 1 }] },
        { id: "right-tool", tools: [{ definition: definition("same"), execute: async () => 2 }] },
      ]),
    ).toThrow("Duplicate capability tool");
    registry.registerTool(definition("existing"));
    expect(() =>
      registerCapabilityModules(registry, [
        { id: "conflict", tools: [{ definition: definition("existing"), execute: async () => 1 }] },
      ]),
    ).toThrow("conflicts with registered tool");
  });

  it("keeps seed capabilities out of the registry exported to EngineRuntime", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-capability-isolation-"));
    try {
      const engine = new Engine({
        llm: { provider: "openai", model: "test", apiKey: "test" },
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        capabilities: [
          {
            id: "arena",
            tools: [{ definition: definition("Arena"), execute: async () => "ok" }],
          },
        ],
      });
      expect(engine.getToolRegistry().hasTool("Arena")).toBe(true);
      expect(engine.getRuntimeToolRegistry().hasTool("Arena")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

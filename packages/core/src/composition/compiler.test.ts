import { describe, expect, test } from "bun:test";
import { compileComposition } from "./compiler.js";
import { CompositionError } from "../exceptions.js";
import type { AgentModule } from "./types.js";
import type { BuiltinTool } from "../tool-system/builtin/index.js";
import type { ExtensionTool } from "../tool-system/capability-module.js";
import type { AgentPreset } from "../preset/index.js";
import type { HookHandler } from "../hooks/registry.js";

const emptyModule = (id: string): AgentModule => ({ id });

const presetTagsTool = (name: string): { kind: "preset-tags"; tool: BuiltinTool } => ({
  kind: "preset-tags",
  tool: {
    definition: { name, description: name, parameters: { type: "object", properties: {} } },
    execute: async () => ({ ok: true }),
    exposure: { presetTags: ["general"] },
  } as unknown as BuiltinTool,
});

const alwaysTool = (name: string): { kind: "always"; tool: ExtensionTool } => ({
  kind: "always",
  tool: {
    definition: { name, description: name, parameters: { type: "object", properties: {} } },
    execute: async () => ({}),
  } as unknown as ExtensionTool,
});

const preset = (name: string): AgentPreset => ({
  name,
  label: name,
  description: name,
  promptSections: [],
  builtinTools: [],
  defaultPermissionRules: [],
});

describe("compileComposition module validation", () => {
  test("core is order 0, host modules follow input order", () => {
    const result = compileComposition({
      modules: [emptyModule("alpha"), emptyModule("beta")],
    });
    expect(result.modules).toEqual([
      { id: "core", order: 0, source: "core" },
      { id: "alpha", order: 1, source: "host" },
      { id: "beta", order: 2, source: "host" },
    ]);
  });

  test("duplicate module id fails loud", () => {
    expect(() =>
      compileComposition({ modules: [emptyModule("alpha"), emptyModule("alpha")] }),
    ).toThrow(CompositionError);
  });

  test("invalid module id format fails loud", () => {
    expect(() => compileComposition({ modules: [emptyModule("Bad Id!")] })).toThrow(
      CompositionError,
    );
  });

  test("missing expected module fails loud", () => {
    expect(() =>
      compileComposition({ modules: [emptyModule("alpha")], expectedModules: ["pet"] }),
    ).toThrow(/pet/);
  });

  test("empty host module produces an empty_module diagnostic", () => {
    const result = compileComposition({ modules: [emptyModule("alpha")] });
    expect(result.diagnostics).toContainEqual({
      code: "empty_module",
      moduleId: "alpha",
      message: 'Module "alpha" declares no contributions',
    });
  });
});

describe("compileComposition contributions", () => {
  test("tool order is preset-tags (module order) then always (module order)", () => {
    const result = compileComposition({
      modules: [
        { id: "alpha", engine: { tools: [alwaysTool("A1"), presetTagsTool("A2")] } },
        { id: "beta", engine: { tools: [presetTagsTool("B1")] } },
      ],
    });
    const names = result.engine.tools.map((t) => t.tool.definition.name);
    const alphaIdx = names.indexOf("A2");
    const betaIdx = names.indexOf("B1");
    const alwaysIdx = names.indexOf("A1");
    expect(alphaIdx).toBeGreaterThanOrEqual(0);
    expect(betaIdx).toBeGreaterThan(alphaIdx);
    expect(alwaysIdx).toBeGreaterThan(betaIdx); // always tools after every preset-tags tool
  });

  test("duplicate tool name across modules fails with both owners", () => {
    const compile = () =>
      compileComposition({
        modules: [
          { id: "alpha", engine: { tools: [presetTagsTool("Dup")] } },
          { id: "beta", engine: { tools: [alwaysTool("Dup")] } },
        ],
      });
    expect(compile).toThrow(CompositionError);
    try {
      compile();
    } catch (error) {
      expect((error as CompositionError).details).toMatchObject({
        code: "duplicate_tool",
        key: "Dup",
        firstModuleId: "alpha",
        secondModuleId: "beta",
      });
    }
  });

  test("duplicate tool against core builtin fails", () => {
    expect(() =>
      compileComposition({
        modules: [{ id: "alpha", engine: { tools: [presetTagsTool("Read")] } }],
      }),
    ).toThrow(/Read/);
  });

  test("conflicting default presets fail; single wins; none falls back to harness-min", () => {
    expect(
      compileComposition({
        modules: [{ id: "alpha", engine: { presets: [preset("p1")], defaultPreset: "p1" } }],
      }).engine.defaultPreset,
    ).toBe("p1");
    expect(compileComposition({}).engine.defaultPreset).toBe("harness-min");
    expect(() =>
      compileComposition({
        modules: [
          { id: "alpha", engine: { presets: [preset("p1")], defaultPreset: "p1" } },
          { id: "beta", engine: { presets: [preset("p2")], defaultPreset: "p2" } },
        ],
      }),
    ).toThrow(CompositionError);
  });

  test("default preset must exist among resolved presets", () => {
    expect(() =>
      compileComposition({ modules: [{ id: "alpha", engine: { defaultPreset: "ghost" } }] }),
    ).toThrow(/ghost/);
  });

  test("preset builtinTools must reference known preset-tags tools", () => {
    expect(() =>
      compileComposition({
        modules: [
          {
            id: "alpha",
            engine: { presets: [{ ...preset("p1"), builtinTools: ["NoSuchTool"] }] },
          },
        ],
      }),
    ).toThrow(/NoSuchTool/);
  });

  test("duplicate preset / prompt section / behavior profile / query / hidden kind fail", () => {
    expect(() =>
      compileComposition({
        modules: [
          { id: "alpha", engine: { presets: [preset("p")] } },
          { id: "beta", engine: { presets: [preset("p")] } },
        ],
      }),
    ).toThrow(CompositionError);
    expect(() =>
      compileComposition({
        modules: [
          { id: "alpha", engine: { promptSections: { s: "a" } } },
          { id: "beta", engine: { promptSections: { s: "b" } } },
        ],
      }),
    ).toThrow(CompositionError);
    expect(() =>
      compileComposition({
        modules: [
          { id: "alpha", engine: { behaviorProfiles: [{ id: "bp" }] } },
          { id: "beta", engine: { behaviorProfiles: [{ id: "bp" }] } },
        ],
      }),
    ).toThrow(CompositionError);
    expect(() =>
      compileComposition({
        modules: [
          { id: "alpha", protocol: { queries: { q: () => null } } },
          { id: "beta", protocol: { queries: { q: () => null } } },
        ],
      }),
    ).toThrow(CompositionError);
    expect(() =>
      compileComposition({
        modules: [
          { id: "alpha", protocol: { hiddenSessionKinds: ["k"] } },
          { id: "beta", protocol: { hiddenSessionKinds: ["k"] } },
        ],
      }),
    ).toThrow(CompositionError);
  });

  test("hooks get capability-prefixed deterministic names and priority 20 default", () => {
    const handler = (async () => ({})) as unknown as HookHandler;
    const result = compileComposition({
      modules: [
        {
          id: "alpha",
          engine: {
            hooks: [
              { event: "on_stop", handler },
              { event: "pre_tool_use", handler, name: "named", priority: 5 },
            ],
          },
        },
      ],
    });
    expect(result.engine.hooks).toEqual([
      {
        moduleId: "alpha",
        event: "on_stop",
        handler,
        priority: 20,
        name: "capability:alpha:on_stop:0",
      },
      {
        moduleId: "alpha",
        event: "pre_tool_use",
        handler,
        priority: 5,
        name: "capability:alpha:named",
      },
    ]);
  });
});

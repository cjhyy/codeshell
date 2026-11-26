import { describe, expect, test } from "bun:test";
import { compileComposition } from "./compiler.js";
import { presetInjectedTools } from "./resolve-preset.js";
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
  test("both module tool contribution kinds reject reserved host-loopback names", () => {
    for (const contribution of [
      alwaysTool("__browser_action__"),
      presetTagsTool("__workspace_action__"),
    ]) {
      expect(() =>
        compileComposition({ modules: [{ id: "extension", engine: { tools: [contribution] } }] }),
      ).toThrow("reserved for internal host requests");
    }
  });

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

  test("host module may shadow a core preset with a diagnostic", () => {
    const shadow = compileComposition({
      modules: [{ id: "alpha", engine: { presets: [preset("general")] } }],
    });
    const rows = shadow.engine.presets.filter((p) => p.key === "general");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.moduleId).toBe("alpha");
    expect(shadow.diagnostics).toContainEqual({
      code: "core_preset_shadowed",
      moduleId: "alpha",
      message: 'Module "alpha" shadows core preset "general"',
    });
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

describe("preset extensions", () => {
  const owner = (
    extensions: NonNullable<AgentModule["engine"]>["presetExtensions"],
  ): AgentModule => ({
    id: "owner",
    engine: {
      tools: [presetTagsTool("OwnerA"), presetTagsTool("OwnerB")],
      presets: [{ ...preset("owned"), builtinTools: ["OwnerA", "OwnerB"] }],
      presetExtensions: extensions,
    },
  });
  const plain: AgentModule = { id: "plain", engine: { tools: [presetTagsTool("PlainTool")] } };
  const injected = (composition: ReturnType<typeof compileComposition>, name: string) =>
    presetInjectedTools(composition, name).map((tool) => tool.definition.name);

  test("adds only the targeted tools, and plain modules still join every preset", () => {
    const composition = compileComposition({
      modules: [owner([{ target: { allExcept: ["owned"] }, tools: ["OwnerA"] }]), plain],
    });
    expect(injected(composition, "general")).toEqual(["OwnerA", "PlainTool"]);
    expect(injected(composition, "owned")).toEqual(["PlainTool"]);
  });

  test("a named target applies only to the named presets", () => {
    const composition = compileComposition({
      modules: [owner([{ target: { presets: ["harness-min"] }, tools: ["OwnerB"] }])],
    });
    expect(injected(composition, "harness-min")).toEqual(["OwnerB"]);
    expect(injected(composition, "general")).toEqual([]);
  });

  test("an extension may not add another module's tool or target an unknown preset", () => {
    expect(() =>
      compileComposition({
        modules: [owner([{ target: { allExcept: [] }, tools: ["PlainTool"] }]), plain],
      }),
    ).toThrow(CompositionError);
    expect(() =>
      compileComposition({
        modules: [owner([{ target: { presets: ["missing"] }, tools: ["OwnerA"] }])],
      }),
    ).toThrow(CompositionError);
  });
});

describe("compileComposition plugin modules", () => {
  const pluginModule = (id: string, engine: AgentModule["engine"] = {}): AgentModule => ({
    id,
    engine,
  });

  test("plugin modules follow every host module and carry their revision", () => {
    const c = compileComposition({
      modules: [emptyModule("host-a")],
      pluginModules: [
        { module: pluginModule("plugin-one-00000000"), revision: "rev-1" },
        { module: pluginModule("plugin-two-00000000"), revision: "rev-2" },
      ],
    });
    expect(c.modules.slice(1)).toEqual([
      { id: "host-a", order: 1, source: "host" },
      { id: "plugin-one-00000000", order: 2, source: "plugin", revision: "rev-1" },
      { id: "plugin-two-00000000", order: 3, source: "plugin", revision: "rev-2" },
    ]);
    // Engine-only is what a plugin module is; only host modules get the diagnostic.
    expect(c.diagnostics.map((d) => d.moduleId)).toEqual(["host-a"]);
  });

  test("the digest follows the revision, so a changed plugin is a different composition", () => {
    const compile = (revision: string) =>
      compileComposition({
        pluginModules: [{ module: pluginModule("plugin-one-00000000"), revision }],
      }).digest;
    expect(compile("rev-1")).toBe(compile("rev-1"));
    expect(compile("rev-1")).not.toBe(compile("rev-2"));
    expect(compile("rev-1")).not.toBe(compileComposition().digest);
  });

  test("a composition without plugin modules is unchanged by their existence", () => {
    expect(compileComposition({ pluginModules: [] }).digest).toBe(compileComposition().digest);
    expect(compileComposition().modules[0]).toEqual({ id: "core", order: 0, source: "core" });
  });

  test.each<[string, Partial<AgentModule>]>([
    ["protocol queries", { protocol: { queries: { "x.get": () => null } } }],
    ["a host activator", { activateHost: () => ({ dispose() {} }) }],
    ["an engine activator", { activateEngine: () => ({ dispose() {} }) }],
    ["a default preset", { engine: { defaultPreset: "general" } }],
    ["a tool-selection adjuster", { engine: { adjustToolSelection: () => {} } }],
    ["a private service", { engine: { privateService: { scope: "engine", create: () => ({}) } } }],
    ["behavior profiles", { engine: { behaviorProfiles: [] } }],
  ])("a plugin module may not contribute %s", (_label, extra) => {
    expect(() =>
      compileComposition({
        pluginModules: [{ module: { id: "plugin-one-00000000", ...extra }, revision: "r" }],
      }),
    ).toThrow(/may not contribute/);
  });

  test("a plugin cannot replace a core preset the way a host module can", () => {
    const core = compileComposition().engine.presets[0]!.key;
    expect(() =>
      compileComposition({
        pluginModules: [
          {
            module: pluginModule("plugin-one-00000000", { presets: [preset(core)] }),
            revision: "r",
          },
        ],
      }),
    ).toThrow(CompositionError);
    expect(() =>
      compileComposition({ modules: [pluginModule("host-a", { presets: [preset(core)] })] }),
    ).not.toThrow();
  });

  test("a tool name clash between two plugins names both of them", () => {
    try {
      compileComposition({
        pluginModules: [
          {
            module: pluginModule("plugin-one-00000000", { tools: [presetTagsTool("Shared")] }),
            revision: "r",
          },
          {
            module: pluginModule("plugin-two-00000000", { tools: [presetTagsTool("Shared")] }),
            revision: "r",
          },
        ],
      });
      throw new Error("expected a conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(CompositionError);
      expect((error as CompositionError).message).toContain("plugin-one-00000000");
      expect((error as CompositionError).message).toContain("plugin-two-00000000");
    }
  });
});

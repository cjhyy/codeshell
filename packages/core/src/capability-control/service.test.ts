import { describe, test, expect } from "bun:test";
import { CapabilityService } from "./service.js";
import { CapabilityNotFoundError } from "./types.js";

/**
 * In-memory fake of the bits of SettingsManager the service touches. get()
 * returns a live object; saveUserSetting applies the dotted-path write back so
 * a subsequent get() reflects it (mirrors the real atomic-write + invalidate).
 */
function fakes(initial: Record<string, unknown> = {}) {
  const s: any = {
    agent: { preset: "general", enabledBuiltinTools: [], disabledBuiltinTools: [] },
    mcpServers: {},
    disabledSkills: [],
    disabledPlugins: [],
    ...initial,
  };
  const settings = {
    get: () => s,
    saveUserSetting: (k: string, v: unknown) => {
      const parts = k.split(".");
      let t: any = s;
      for (let i = 0; i < parts.length - 1; i++) t = t[parts[i]!] ??= {};
      t[parts[parts.length - 1]!] = v;
    },
  };
  const registry = { listToolsDetailed: () => [] as any[] };
  const emptyPlugins = () => ({ version: 2 as const, plugins: {} });
  return { settings, registry, get: () => s, emptyPlugins };
}

const repl = {
  name: "REPL",
  description: "",
  inputSchema: {},
  source: "builtin",
  permissionDefault: "allow",
};

describe("CapabilityService.setEnabled", () => {
  test("denylist: off adds token; on removes it", () => {
    const f = fakes();
    const svc = new CapabilityService({
      registry: f.registry as any,
      settings: f.settings as any,
      cwd: "/x",
      scanSkills: () =>
        [
          {
            name: "a",
            description: "",
            content: "",
            filePath: "/x/a",
            source: "project",
          },
        ] as any,
      scanAgents: () => [],
      readInstalledPlugins: f.emptyPlugins as any,
      resolveBuiltinToolNames: () => [],
    });
    svc.setEnabled("skill:a", false);
    expect(f.get().disabledSkills).toEqual(["a"]);
    svc.setEnabled("skill:a", true);
    expect(f.get().disabledSkills).toEqual([]);
  });

  test("allowlist: builtin not in preset writes agent.enabledBuiltinTools (dotted)", () => {
    const f = fakes();
    const svc = new CapabilityService({
      registry: { listToolsDetailed: () => [repl] } as any,
      settings: f.settings as any,
      cwd: "/x",
      scanSkills: () => [],
      scanAgents: () => [],
      readInstalledPlugins: f.emptyPlugins as any,
      resolveBuiltinToolNames: (o?: any) =>
        o?.enabledBuiltinTools?.length ? ["REPL"] : [],
    });
    svc.setEnabled("builtin:REPL", true);
    expect(f.get().agent.enabledBuiltinTools).toEqual(["REPL"]);
    svc.setEnabled("builtin:REPL", false);
    expect(f.get().agent.enabledBuiltinTools).toEqual([]);
  });

  test("record-flag: flips mcpServers[token].enabled, never creates missing server", () => {
    const f = fakes({ mcpServers: { gh: { name: "gh" } } });
    const svc = new CapabilityService({
      registry: f.registry as any,
      settings: f.settings as any,
      cwd: "/x",
      scanSkills: () => [],
      scanAgents: () => [],
      readInstalledPlugins: f.emptyPlugins as any,
      resolveBuiltinToolNames: () => [],
    });
    svc.setEnabled("mcp:gh", false);
    expect(f.get().mcpServers.gh.enabled).toBe(false);
    svc.setEnabled("mcp:gh", true);
    expect(f.get().mcpServers.gh.enabled).toBe(true);
  });

  test("throws CapabilityNotFoundError on unknown id", () => {
    const f = fakes();
    const svc = new CapabilityService({
      registry: f.registry as any,
      settings: f.settings as any,
      cwd: "/x",
      scanSkills: () => [],
      scanAgents: () => [],
      readInstalledPlugins: f.emptyPlugins as any,
      resolveBuiltinToolNames: () => [],
    });
    expect(() => svc.setEnabled("skill:nope", true)).toThrow(
      CapabilityNotFoundError,
    );
  });
});

describe("CapabilityService.list", () => {
  test("composes all five sources", () => {
    const f = fakes({ mcpServers: { gh: { name: "gh" } } });
    const svc = new CapabilityService({
      registry: {
        listToolsDetailed: () => [
          {
            name: "Read",
            description: "",
            inputSchema: {},
            source: "builtin",
            permissionDefault: "allow",
          },
        ],
      } as any,
      settings: f.settings as any,
      cwd: "/x",
      scanSkills: () =>
        [
          {
            name: "a",
            description: "",
            content: "",
            filePath: "/x/a",
            source: "project",
          },
        ] as any,
      scanAgents: () => [{ name: "researcher", description: "rd", systemPrompt: "", source: "project" }] as any,
      readInstalledPlugins: () => ({ version: 2, plugins: { "p@m": [] } }) as any,
      resolveBuiltinToolNames: () => ["Read"],
    });
    const kinds = new Set(svc.list().map((d) => d.kind));
    expect(kinds).toEqual(new Set(["builtin", "mcp", "skill", "plugin", "agent"]));
  });
});

/**
 * Project-scope fake: like fakes() but also records project writes/deletes and
 * exposes getForScope returning the in-memory capabilityOverrides, so we can
 * assert the project overlay write path and the overlay-aware list().
 */
function fakesWithProject(initial: Record<string, unknown> = {}) {
  const s: any = {
    agent: { preset: "general", enabledBuiltinTools: [], disabledBuiltinTools: [] },
    mcpServers: {},
    disabledSkills: [],
    disabledPlugins: [],
    capabilityOverrides: {},
    ...initial,
  };
  const projectWrites: Array<[string, unknown]> = [];
  const projectDeletes: string[] = [];
  const settings = {
    get: () => s,
    saveUserSetting: (k: string, v: unknown) => {
      const parts = k.split(".");
      let t: any = s;
      for (let i = 0; i < parts.length - 1; i++) t = t[parts[i]!] ??= {};
      t[parts[parts.length - 1]!] = v;
    },
    saveProjectSetting: (k: string, v: unknown, _cwd: string) => {
      projectWrites.push([k, v]);
      const parts = k.split(".");
      let t: any = s;
      for (let i = 0; i < parts.length - 1; i++) t = t[parts[i]!] ??= {};
      t[parts[parts.length - 1]!] = v;
    },
    deleteProjectSetting: (k: string, _cwd: string) => {
      projectDeletes.push(k);
      const parts = k.split(".");
      let t: any = s;
      for (let i = 0; i < parts.length - 1; i++) t = t?.[parts[i]!];
      if (t) delete t[parts[parts.length - 1]!];
    },
    getForScope: (_scope: "user" | "project", _cwd?: string) => ({
      capabilityOverrides: s.capabilityOverrides,
    }),
  };
  const registry = { listToolsDetailed: () => [] as any[] };
  const emptyPlugins = () => ({ version: 2 as const, plugins: {} });
  return { settings, registry, get: () => s, emptyPlugins, projectWrites, projectDeletes };
}

describe("CapabilityService project scope", () => {
  function svcFor(f: ReturnType<typeof fakesWithProject>) {
    return new CapabilityService({
      registry: f.registry as any,
      settings: f.settings as any,
      cwd: "/proj",
      scanSkills: () =>
        [{ name: "a", description: "", content: "", filePath: "/x/a", source: "project" }] as any,
      scanAgents: () => [],
      readInstalledPlugins: f.emptyPlugins as any,
      resolveBuiltinToolNames: () => [],
    });
  }

  test("setOverride 'off' writes capabilityOverrides.skills.<token>", () => {
    const f = fakesWithProject();
    svcFor(f).setOverride("skill:a", "off", { scope: "project", cwd: "/proj" });
    expect(f.projectWrites).toContainEqual(["capabilityOverrides.skills.a", "off"]);
  });

  test("setOverride 'on' writes 'on'", () => {
    const f = fakesWithProject();
    svcFor(f).setOverride("skill:a", "on", { scope: "project", cwd: "/proj" });
    expect(f.projectWrites).toContainEqual(["capabilityOverrides.skills.a", "on"]);
  });

  test("setOverride 'inherit' deletes the key (not a literal write)", () => {
    const f = fakesWithProject({ capabilityOverrides: { skills: { a: "off" } } });
    svcFor(f).setOverride("skill:a", "inherit", { scope: "project", cwd: "/proj" });
    expect(f.projectDeletes).toContain("capabilityOverrides.skills.a");
  });

  test("setEnabled with scope:user keeps old global behavior", () => {
    const f = fakesWithProject();
    svcFor(f).setEnabled("skill:a", false, { scope: "user" });
    expect(f.get().disabledSkills).toEqual(["a"]);
    expect(f.projectWrites).toEqual([]);
  });

  test("setEnabled with no opts defaults to user scope (back-compat)", () => {
    const f = fakesWithProject();
    svcFor(f).setEnabled("skill:a", false);
    expect(f.get().disabledSkills).toEqual(["a"]);
  });

  test("setEnabled scope:project routes to setOverride", () => {
    const f = fakesWithProject();
    svcFor(f).setEnabled("skill:a", false, { scope: "project", cwd: "/proj" });
    expect(f.projectWrites).toContainEqual(["capabilityOverrides.skills.a", "off"]);
  });

  test("list(cwd) reflects project override: global off + project on => enabled", () => {
    const f = fakesWithProject({
      disabledSkills: ["a"],
      capabilityOverrides: { skills: { a: "on" } },
    });
    const d = svcFor(f).list("/proj").find((c) => c.id === "skill:a")!;
    expect(d.globalEnabled).toBe(false);
    expect(d.projectOverride).toBe("on");
    expect(d.enabled).toBe(true);
    expect(d.effectiveSource).toBe("project");
  });

  test("list() with no cwd = user view: no projectOverride, enabled=global", () => {
    const f = fakesWithProject({ disabledSkills: ["a"] });
    const d = svcFor(f).list().find((c) => c.id === "skill:a")!;
    expect(d.enabled).toBe(false);
    expect(d.projectOverride).toBeUndefined();
    expect(d.effectiveSource).toBe("user");
  });

  test("project override 'off' wins over MCP enabled baseline", () => {
    const f = fakesWithProject({
      mcpServers: { playwright: { name: "playwright" } },
      capabilityOverrides: { mcp: { playwright: "off" } },
    });
    const d = svcFor(f).list("/proj").find((c) => c.id === "mcp:playwright")!;
    expect(d.globalEnabled).toBe(true);
    expect(d.enabled).toBe(false);
  });

  test("setOverride rejects builtin (no override bucket)", () => {
    const f = fakesWithProject();
    const svc = new CapabilityService({
      registry: {
        listToolsDetailed: () => [
          { name: "REPL", description: "", inputSchema: {}, source: "builtin", permissionDefault: "allow" },
        ],
      } as any,
      settings: f.settings as any,
      cwd: "/proj",
      scanSkills: () => [],
      scanAgents: () => [],
      readInstalledPlugins: f.emptyPlugins as any,
      resolveBuiltinToolNames: () => [],
    });
    expect(() => svc.setOverride("builtin:REPL", "off", { scope: "project", cwd: "/proj" })).toThrow();
  });
});

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
      readInstalledPlugins: f.emptyPlugins as any,
      resolveBuiltinToolNames: () => [],
    });
    expect(() => svc.setEnabled("skill:nope", true)).toThrow(
      CapabilityNotFoundError,
    );
  });
});

describe("CapabilityService.list", () => {
  test("composes all four sources", () => {
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
      readInstalledPlugins: () => ({ version: 2, plugins: { "p@m": [] } }) as any,
      resolveBuiltinToolNames: () => ["Read"],
    });
    const kinds = new Set(svc.list().map((d) => d.kind));
    expect(kinds).toEqual(new Set(["builtin", "mcp", "skill", "plugin"]));
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createSessionToolHost,
  type CreateSessionToolHostOptions,
  type SessionToolHost,
} from "./session-tool-host.js";
import { ToolRegistry } from "./registry.js";
import type { ToolContext } from "./context.js";
import { HookRegistry } from "../hooks/registry.js";
import type { CapabilityOverrides } from "../settings/schema.js";
import { noRepoDir, SettingsManager } from "../settings/manager.js";
import { effectiveProjectOverrides } from "../capability-control/overlay.js";
import { assembleRunToolDefs } from "../engine/run-tooling.js";
import { appendInstallEntry, pluginInstallKey } from "../plugins/installedPlugins.js";
import { invalidateSkillCache } from "../skills/scanner.js";
import type { StreamEvent } from "../types.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("SessionToolHost live capability policy", () => {
  let root: string;
  let cwd: string;
  let home: string;
  let previousHome: string | undefined;
  let hosts: SessionToolHost[];
  let calls: string[];
  let registry: ToolRegistry;

  function settings(value: unknown, scope: "project" | "local" | "user" = "project", at = cwd) {
    const directory = join(scope === "user" ? home : at, ".code-shell");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, scope === "local" ? "settings.local.json" : "settings.json"),
      JSON.stringify(value),
    );
  }

  function register(
    name: string,
    execute?: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<unknown>,
    ask = false,
  ) {
    registry.registerTool(
      {
        name,
        description: `${name} policy fixture`,
        inputSchema: { type: "object", properties: {} },
        source: "builtin",
        permissionDefault: ask ? "ask" : "allow",
        isReadOnly: !ask,
        isConcurrencySafe: true,
      },
      execute ??
        (async () => {
          calls.push(name);
          return `${name} ran`;
        }),
    );
  }

  function makeHost(overrides: Partial<CreateSessionToolHostOptions> = {}) {
    const host = createSessionToolHost({
      businessSessionId: `policy-${hosts.length}`,
      cwd,
      registry,
      permissionMode: "default",
      planMode: false,
      projectTrusted: true,
      settingsScope: "full",
      presetRules: ["Visible", "Secret", "Skill", "ToolSearch", "Parent", "Inspect"].map(
        (tool) => ({ tool, decision: "allow" as const }),
      ),
      exposure: {
        mode: "allowlist",
        toolNames: new Set(["Visible", "Skill", "ToolSearch", "Parent", "Inspect", "WriteFixture"]),
      },
      visibility: { cwd, hasGoal: false },
      hooks: new HookRegistry(),
      ...overrides,
    });
    hosts.push(host);
    return host;
  }

  async function invoke(host: SessionToolHost, name: string, input: Record<string, unknown> = {}) {
    return host.execute({ id: `${name}-${Math.random()}`, name, input });
  }

  function skill(name: string, parent = cwd) {
    const dir = join(parent, ".code-shell", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: fixture ${name}\n---\nPRIVATE BODY ${name}\n`,
    );
    invalidateSkillCache();
  }

  function pluginSkill() {
    const plugin = join(root, "plugin");
    mkdirSync(join(plugin, "skills", "read"), { recursive: true });
    writeFileSync(
      join(plugin, "skills", "read", "SKILL.md"),
      "---\ndescription: plugin fixture\n---\nPRIVATE PLUGIN BODY\n",
    );
    appendInstallEntry(pluginInstallKey("fixture", "local"), {
      scope: "user",
      installPath: plugin,
      version: "1",
      installedAt: "t",
      lastUpdated: "t",
    });
    invalidateSkillCache();
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "session-tool-policy-"));
    cwd = join(root, "project");
    home = join(root, "home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(home, { recursive: true });
    previousHome = process.env.HOME;
    process.env.HOME = home;
    hosts = [];
    calls = [];
    registry = new ToolRegistry({ builtinTools: ["Skill", "ToolSearch"] });
    register("Visible");
    register("Secret");
    invalidateSkillCache();
  });

  afterEach(async () => {
    await Promise.all(hosts.map((host) => host.dispose()));
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    invalidateSkillCache();
    rmSync(root, { recursive: true, force: true });
  });

  test("global, project and local toggles agree across discovery, ToolSearch and direct calls", async () => {
    const host = makeHost();
    for (const [user, project, local, enabled] of [
      [{ agent: { disabledBuiltinTools: ["Visible"] } }, {}, {}, false],
      [
        { agent: { disabledBuiltinTools: ["Visible"] } },
        { capabilityOverrides: { builtin: { Visible: "on", Secret: "on" } } },
        {},
        true,
      ],
      [
        {},
        { capabilityOverrides: { builtin: { Visible: "on" } } },
        { capabilityOverrides: { builtin: { Visible: "off" } } },
        false,
      ],
      [
        {},
        { capabilityOverrides: { builtin: { Visible: "off" } } },
        { capabilityOverrides: { builtin: { Visible: "on" } } },
        true,
      ],
    ] as const) {
      settings(user, "user");
      settings(project);
      settings(local, "local");
      expect(host.listTools().some((tool) => tool.name === "Visible")).toBe(enabled);
      const search = await invoke(host, "ToolSearch", { query: "select:Visible,Secret" });
      expect(search.result).toContain('Tool "Secret" is not available');
      expect(String(search.result).includes('Tool "Visible" is not available')).toBe(!enabled);
      expect((await invoke(host, "Visible")).isError === true).toBe(!enabled);
      expect((await invoke(host, "Secret")).isError).toBe(true);
    }
    expect(calls).toEqual(["Visible", "Visible"]);
  });

  test("a live pinned Profile replaces the persisted profile, including an empty pin", async () => {
    settings({
      profile: { active: "project-default", overrides: { builtin: { Visible: "off" } } },
    });
    const fallback = makeHost();
    let profile: CapabilityOverrides = {};
    const pinned = makeHost({ getProfileOverrides: () => profile });
    expect((await invoke(fallback, "Visible")).isError).toBe(true);
    expect((await invoke(pinned, "Visible")).result).toBe("Visible ran");
    profile = { builtin: { Visible: "off" } };
    expect((await invoke(pinned, "Visible")).isError).toBe(true);
    profile = { builtin: { Visible: "on", Secret: "on" } };
    expect((await invoke(pinned, "Visible")).result).toBe("Visible ran");
    expect((await invoke(pinned, "Secret")).isError).toBe(true);
    settings({ capabilityOverrides: { builtin: { Visible: "off" } } });
    expect((await invoke(pinned, "Visible")).isError).toBe(true);
  });

  test("live skill and plugin switches block both metadata and content, then re-enable", async () => {
    skill("notes");
    pluginSkill();
    let profile: CapabilityOverrides = {};
    const host = makeHost({ getProfileOverrides: () => profile });
    const names = async () =>
      JSON.parse(String((await invoke(host, "Skill", { query: "" })).result))
        .results.map((item: { name: string }) => item.name)
        .sort();
    expect(await names()).toEqual(["fixture:read", "notes"]);
    expect((await invoke(host, "Skill", { skill: "notes" })).result).toContain("PRIVATE BODY");
    profile = { skills: { notes: "off" }, plugins: { fixture: "off" } };
    expect(await names()).toEqual([]);
    expect((await invoke(host, "Skill", { skill: "notes" })).isError).toBe(true);
    expect((await invoke(host, "Skill", { skill: "fixture:read" })).isError).toBe(true);
    profile = { skills: { notes: "on" }, plugins: { fixture: "on" } };
    expect(await names()).toEqual(["fixture:read", "notes"]);
    expect((await invoke(host, "Skill", { skill: "fixture:read" })).result).toContain(
      "PRIVATE PLUGIN BODY",
    );
  });

  test("explicit context restrictions and Skill allowlists remain narrower than Profile on", async () => {
    skill("notes");
    pluginSkill();
    const host = makeHost({
      getProfileOverrides: () => ({
        builtin: { Visible: "on" },
        skills: { notes: "on" },
        plugins: { fixture: "on" },
      }),
      contextOverrides: {
        disabledBuiltins: new Set(["Visible"]),
        disabledPlugins: ["fixture"],
        skillAllowlist: [],
      },
    });
    expect((await invoke(host, "Visible")).isError).toBe(true);
    expect((await invoke(host, "Skill", { skill: "notes" })).isError).toBe(true);
    expect((await invoke(host, "Skill", { skill: "fixture:read" })).isError).toBe(true);
    expect(JSON.parse(String((await invoke(host, "Skill", { query: "" })).result)).results).toEqual(
      [],
    );
  });

  test("revocation while approval waits wins over the approved answer", async () => {
    register("WriteFixture", undefined, true);
    const asked = deferred();
    const answer = deferred<{ approved: boolean }>();
    const host = makeHost({
      approvalBackend: {
        requestApproval: async () => {
          asked.resolve();
          return answer.promise;
        },
      },
    });
    const pending = invoke(host, "WriteFixture");
    await asked.promise;
    settings({ capabilityOverrides: { builtin: { WriteFixture: "off" } } });
    answer.resolve({ approved: true });
    expect((await pending).error).toContain("disabled before execution");
    expect(calls).toEqual([]);
  });

  test("nested bound calls refresh their own context after the parent has started", async () => {
    const entered = deferred();
    const resume = deferred();
    register("Parent", async (_args, ctx) => {
      entered.resolve();
      await resume.promise;
      return JSON.stringify(
        await ctx!.executeBoundTool!({ id: "nested", toolName: "Skill", args: { skill: "notes" } }),
      );
    });
    skill("notes");
    const host = makeHost();
    const pending = invoke(host, "Parent");
    await entered.promise;
    settings({ capabilityOverrides: { skills: { notes: "off" } } });
    resume.resolve();
    expect((await pending).result).toContain("is disabled");
    expect(calls).toEqual([]);
  });

  test("concurrent calls and discovery do not mutate an already executing context", async () => {
    const entered = deferred();
    const resume = deferred();
    register("Inspect", async (args, ctx) => {
      const before = ctx!.disabledSkills;
      if (args.wait) {
        entered.resolve();
        await resume.promise;
      }
      return JSON.stringify({ before, after: ctx!.disabledSkills });
    });
    const host = makeHost();
    const first = invoke(host, "Inspect", { wait: true });
    await entered.promise;
    settings({ disabledSkills: ["notes"] });
    host.listTools();
    const second = await invoke(host, "Inspect");
    resume.resolve();
    expect(JSON.parse(String(second.result))).toEqual({ before: ["notes"], after: ["notes"] });
    expect(JSON.parse(String((await first).result))).toEqual({ before: [], after: [] });
    expect(host.toolContext.disabledSkills).toBeUndefined();
  });

  test("the no-repo scope retains default-off Skill and plugin policy", async () => {
    skill("notes", home);
    pluginSkill();
    const noRepo = noRepoDir();
    mkdirSync(noRepo, { recursive: true });
    let profile: CapabilityOverrides = {};
    const host = makeHost({ cwd: noRepo, getProfileOverrides: () => profile });
    expect(JSON.parse(String((await invoke(host, "Skill", { query: "" })).result)).results).toEqual(
      [],
    );
    expect((await invoke(host, "Skill", { skill: "notes" })).isError).toBe(true);
    profile = { skills: { notes: "on", "fixture:read": "on" }, plugins: { fixture: "on" } };
    expect((await invoke(host, "Skill", { skill: "notes" })).result).toContain("PRIVATE BODY");
    expect((await invoke(host, "Skill", { skill: "fixture:read" })).result).toContain(
      "PRIVATE PLUGIN BODY",
    );
  });

  test("unreadable selected policy fails closed while isolated scope ignores project files", async () => {
    const host = makeHost();
    settings({});
    writeFileSync(join(cwd, ".code-shell", "settings.json"), "{");
    expect(() => host.listTools()).toThrow("capability settings");
    expect((await invoke(host, "Visible")).isError).toBe(true);
    expect(calls).toEqual([]);
    const isolated = makeHost({ settingsScope: "isolated" });
    expect((await invoke(isolated, "Visible")).result).toBe("Visible ran");
    settings({});
    const brokenPin = makeHost({
      getProfileOverrides: () => {
        throw new Error("Profile missing");
      },
    });
    expect(() => brokenPin.listTools()).toThrow("capability settings");
    expect((await invoke(brokenPin, "Visible")).isError).toBe(true);
  });

  test("full scope reads global disabled tools while project scope remains local-first", async () => {
    settings({ agent: { disabledBuiltinTools: ["Visible"] } }, "user");
    expect((await invoke(makeHost(), "Visible")).isError).toBe(true);
    expect((await invoke(makeHost({ settingsScope: "project" }), "Visible")).result).toBe(
      "Visible ran",
    );
  });

  test("a policy failure closes the started tool stream with an error result", async () => {
    const events: StreamEvent[] = [];
    const host = makeHost({
      getProfileOverrides: () => {
        throw new Error("Profile missing");
      },
      contextOverrides: {
        streamCallback: (event) => {
          events.push(event);
        },
      },
    });
    const result = await invoke(host, "Visible");
    expect(result.isError).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["tool_use_start", "tool_result"]);
    expect(events[1]).toEqual({ type: "tool_result", result });
    expect(calls).toEqual([]);
  });

  test("the fixture's external list equals native project-off filtering intersected with exposure", () => {
    settings({ capabilityOverrides: { builtin: { Visible: "off" } } });
    const host = makeHost();
    const builtinOverride = effectiveProjectOverrides(
      new SettingsManager(cwd, "full", true),
      cwd,
    )?.builtin;
    const native = assembleRunToolDefs({
      toolRegistry: registry,
      toolCtx: { cwd } as ToolContext,
      guardCwd: cwd,
      hasRunnableGoal: false,
      settingsScope: "full",
      builtinToolHost: undefined,
      isSubAgent: false,
      behaviorProfileId: undefined,
      profileMeta: undefined,
      builtinOverride,
      mcpServers: {},
      mcpDisabled: false,
      featureFlags: undefined,
      toolGuards: new Map(),
      toolRewriters: new Map(),
      toolFeatureFlags: new Map(),
      applyBuiltinOverrideVisibility: (tools, overrides) =>
        tools.filter((tool) => overrides?.[tool.name] !== "off"),
      profileAllowedToolNames: undefined,
      runPlanMode: false,
    });
    expect(
      host
        .listTools()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(
      native
        .filter((tool) => tool.name !== "Secret")
        .map((tool) => tool.name)
        .sort(),
    );
  });
});

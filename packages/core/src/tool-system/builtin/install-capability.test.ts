import { afterEach, describe, expect, it } from "bun:test";
import type { SettingsManager } from "../../settings/manager.js";
import type { ToolContext } from "../context.js";
import type { SafeSpawnResult } from "../../runtime/safe-spawn.js";
import { BUILTIN_TOOLS } from "./index.js";
import {
  installCapabilityToolDef,
  installCapabilityWithDeps,
  setCapabilityChangedSink,
  type InstallCapabilityDeps,
} from "./install-capability.js";

function spawnResult(overrides: Partial<SafeSpawnResult> = {}): SafeSpawnResult {
  return {
    reason: "ok",
    stdout: "installed",
    stderr: "",
    exitCode: 0,
    signal: null,
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false,
    spawnFailed: false,
    ...overrides,
  };
}

function deps(overrides: Partial<InstallCapabilityDeps> = {}): InstallCapabilityDeps {
  return {
    computeEffectiveDisabledLists: () => ({
      disabledSkills: [],
      disabledPlugins: [],
      disabledPluginHooks: [],
    }),
    describePluginContent: () => ({
      skills: [],
      commands: [],
      agents: [],
      hooks: [],
      mcpServers: [],
      automationTemplates: [],
    }),
    installPlugin: async () => ({
      ok: true,
      entry: {
        scope: "user",
        installPath: "/tmp/plugin",
        version: "1.0.0",
        installedAt: "now",
        lastUpdated: "now",
      },
      freshlyCloned: true,
      varRewrite: { filesScanned: 0, filesRewritten: 0 },
    }),
    invalidateSkillCache: () => {},
    listInstalled: () => [],
    listPluginMcpTrust: () => [],
    makeSettingsManager: () =>
      ({
        getForScope: () => ({}),
        saveLocalSetting: () => {},
        saveProjectSetting: () => {},
        saveUserSetting: () => {},
      }) as unknown as SettingsManager,
    previewMarketplacePlugin: async (plugin) => ({
      entry: { name: plugin, source: "./plugin" },
      inventory: null,
    }),
    refreshMarketplace: async (name) => ({
      ok: true,
      name,
      marketplace: { name, owner: { name: "test" }, plugins: [] },
      replaced: true,
    }),
    resolveExecutable: (file) => file,
    safeSpawn: async () => spawnResult(),
    scanSkills: () => [],
    uninstallPlugin: () => ({
      ok: true,
      removedFromManifest: true,
      removedFromDisk: true,
    }),
    ...overrides,
  };
}

function ctx(cwd = process.cwd()): ToolContext {
  return { cwd, settingsScope: "full" } as ToolContext;
}

afterEach(() => setCapabilityChangedSink(null));

describe("InstallCapability tool", () => {
  it("is an approval-gated builtin in the general preset", () => {
    expect(installCapabilityToolDef.name).toBe("InstallCapability");
    const entry = BUILTIN_TOOLS.find((tool) => tool.definition.name === "InstallCapability");
    expect(entry?.definition.permissionDefault).toBe("ask");
    expect(entry?.definition.isReadOnly).toBe(false);
    expect(entry?.exposure.presetTags).toContain("general");
    expect(entry?.exposure.defaultPermissionRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          argsPattern: { action: "^list$" },
          decision: "allow",
        }),
        expect.objectContaining({
          argsPattern: { action: "^inspect$", kind: "^(plugin|mcp)$" },
          decision: "allow",
        }),
        expect.objectContaining({
          argsPattern: { action: "^inspect$", kind: "^skill$" },
          decision: "ask",
        }),
        expect.objectContaining({
          argsPattern: { action: "^(install|update|enable|disable|uninstall)$" },
          decision: "ask",
        }),
      ]),
    );
  });

  it("installs an exact marketplace plugin and reports contributed content", async () => {
    const calls: string[] = [];
    const out = await installCapabilityWithDeps(
      { kind: "plugin", plugin: "docs", marketplace: "official" },
      ctx(),
      deps({
        installPlugin: async (plugin, marketplace) => {
          calls.push(`${plugin}@${marketplace}`);
          return {
            ok: true,
            entry: {
              scope: "user",
              installPath: "/tmp/docs",
              version: "2.0.0",
              installedAt: "now",
              lastUpdated: "now",
            },
            freshlyCloned: true,
            varRewrite: { filesScanned: 2, filesRewritten: 0 },
          };
        },
        describePluginContent: () => ({
          skills: [{ name: "pdf" }],
          commands: ["summarize"],
          agents: [],
          hooks: [],
          mcpServers: ["search"],
          automationTemplates: [],
        }),
        listPluginMcpTrust: () => [
          {
            installKey: "docs@official",
            plugin: "docs",
            serverNames: ["search"],
            status: "pending",
          },
        ],
      }),
    );
    expect(calls).toEqual(["docs@official"]);
    expect(out).toContain("Installed plugin docs@official (2.0.0)");
    expect(out).toContain("docs:pdf");
    expect(out).toContain("MCP servers: search (trust: pending)");
    expect(out).toContain("remain disabled");
  });

  it("previews marketplace plugin contents without installing", async () => {
    let installs = 0;
    const out = await installCapabilityWithDeps(
      { action: "inspect", kind: "plugin", plugin: "docs", marketplace: "official" },
      ctx(),
      deps({
        installPlugin: async () => {
          installs += 1;
          throw new Error("must not install");
        },
        previewMarketplacePlugin: async () => ({
          entry: {
            name: "docs",
            description: "Documentation workflows",
            version: "2.0.0",
            source: "./plugins/docs",
          },
          inventory: {
            name: "docs",
            format: "codex",
            version: "2.0.0",
            source: { kind: "dir", label: "docs" },
            alreadyInstalled: false,
            reviewToken: "a".repeat(64),
            skills: [{ name: "pdf" }],
            commands: ["summarize"],
            agents: ["researcher"],
            hooks: [
              {
                event: "SessionStart",
                command: "node setup.js",
                commandTruncated: false,
              },
            ],
            mcpServers: [{ name: "search", transport: "streamable-http" }],
            automationTemplates: [],
            interface: {
              capabilities: [],
              defaultPrompt: [],
              externalLinks: [],
              media: { screenshots: [] },
            },
            warnings: [{ kind: "executable-hooks", severity: "warning", count: 1 }],
          },
        }),
      }),
    );
    expect(installs).toBe(0);
    expect(out).toContain("Plugin docs@official");
    expect(out).toContain("Skills: pdf");
    expect(out).toContain("MCP servers: search (streamable-http)");
    expect(out).toContain("Review warnings: executable-hooks=1");
    expect(out).toContain("Not installed");
  });

  it("refreshes a stale marketplace once before reporting plugin install failure", async () => {
    let attempts = 0;
    let refreshes = 0;
    const out = await installCapabilityWithDeps(
      { kind: "plugin", plugin: "new-plugin", marketplace: "official" },
      ctx(),
      deps({
        installPlugin: async () => {
          attempts += 1;
          if (attempts === 1) {
            return { ok: false, error: 'plugin "new-plugin" not found in marketplace "official".' };
          }
          return {
            ok: true,
            entry: {
              scope: "user",
              installPath: "/tmp/new-plugin",
              version: "1.0.0",
              installedAt: "now",
              lastUpdated: "now",
            },
            freshlyCloned: true,
            varRewrite: { filesScanned: 0, filesRewritten: 0 },
          };
        },
        refreshMarketplace: async (name) => {
          refreshes += 1;
          return {
            ok: true,
            name,
            marketplace: { name, owner: { name: "test" }, plugins: [] },
            replaced: true,
          };
        },
      }),
    );
    expect(attempts).toBe(2);
    expect(refreshes).toBe(1);
    expect(out).toContain("Installed plugin new-plugin@official");
  });

  it("updates and uninstalls only an exact installed plugin key", async () => {
    const calls: string[] = [];
    const installedEntry = {
      scope: "user" as const,
      installPath: "/tmp/docs",
      version: "1.0.0",
      installedAt: "now",
      lastUpdated: "now",
    };
    const common = deps({
      listInstalled: () => [{ key: "docs@official", entry: installedEntry }],
      installPlugin: async (plugin, marketplace) => {
        calls.push(`install:${plugin}@${marketplace}`);
        return {
          ok: true,
          entry: { ...installedEntry, version: "2.0.0" },
          freshlyCloned: true,
          varRewrite: { filesScanned: 0, filesRewritten: 0 },
        };
      },
      refreshMarketplace: async (name) => {
        calls.push(`refresh:${name}`);
        return {
          ok: true,
          name,
          marketplace: { name, owner: { name: "test" }, plugins: [] },
          replaced: true,
        };
      },
      uninstallPlugin: (plugin, marketplace) => {
        calls.push(`uninstall:${plugin}@${marketplace}`);
        return { ok: true, removedFromManifest: true, removedFromDisk: true };
      },
    });
    const updated = await installCapabilityWithDeps(
      { action: "update", kind: "plugin", plugin: "docs", marketplace: "official" },
      ctx(),
      common,
    );
    const removed = await installCapabilityWithDeps(
      { action: "uninstall", kind: "plugin", plugin: "docs", marketplace: "official" },
      ctx(),
      common,
    );
    expect(calls).toEqual(["refresh:official", "install:docs@official", "uninstall:docs@official"]);
    expect(updated).toContain("Updated plugin docs@official to 2.0.0");
    expect(removed).toContain("Uninstalled plugin docs@official");
  });

  it("uses the reviewed npx argv for project Skills and verifies discovery", async () => {
    const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
    let scans = 0;
    const cwd = process.cwd();
    const out = await installCapabilityWithDeps(
      {
        kind: "skill",
        repo: "https://github.com/openai/skills",
        skills: ["pdf"],
        full_depth: true,
      },
      ctx(cwd),
      deps({
        safeSpawn: async (file, args, options) => {
          calls.push({ file, args, cwd: options.cwd });
          return spawnResult();
        },
        scanSkills: () => {
          scans += 1;
          return scans === 1
            ? []
            : [
                {
                  name: "pdf",
                  description: "PDF",
                  content: "",
                  filePath: `${cwd}/.agents/skills/pdf/SKILL.md`,
                  source: "project",
                },
              ];
        },
      }),
    );
    expect(calls).toEqual([
      {
        file: "npx",
        args: [
          "--yes",
          "skills",
          "add",
          "openai/skills",
          "--skill",
          "pdf",
          "--agent",
          "*",
          "--yes",
          "--full-depth",
        ],
        cwd,
      },
    ]);
    expect(out).toContain("Installed project Skill capability from openai/skills: pdf");
  });

  it("inspects a Skill repository with the CLI list mode and makes no installation", async () => {
    const calls: string[][] = [];
    const out = await installCapabilityWithDeps(
      {
        action: "inspect",
        kind: "skill",
        repo: "openai/skills",
        full_depth: true,
      },
      ctx(),
      deps({
        safeSpawn: async (_file, args) => {
          calls.push(args);
          return spawnResult({ stdout: "Available Skills\n  pdf\n  docs" });
        },
      }),
    );
    expect(calls).toEqual([["--yes", "skills", "add", "openai/skills", "--list", "--full-depth"]]);
    expect(out).toContain("Available Skills from openai/skills");
    expect(out).toContain("Nothing was installed");
  });

  it("blocks a named Skill collision unless replace=true is reviewed", async () => {
    let spawned = false;
    const cwd = process.cwd();
    const conflictDeps = deps({
      safeSpawn: async () => {
        spawned = true;
        return spawnResult();
      },
      scanSkills: () => [
        {
          name: "pdf",
          description: "Existing PDF workflow",
          content: "",
          filePath: `${cwd}/.code-shell/skills/pdf/SKILL.md`,
          source: "project",
        },
      ],
    });
    const out = await installCapabilityWithDeps(
      { kind: "skill", repo: "openai/skills", skills: ["pdf"] },
      ctx(cwd),
      conflictDeps,
    );
    expect(spawned).toBe(false);
    expect(out).toContain("Skill name conflict detected");
    expect(out).toContain("replace=true");
  });

  it("refuses standalone user-scope Skill installation", async () => {
    const out = await installCapabilityWithDeps(
      { kind: "skill", scope: "user", repo: "openai/skills" },
      ctx(),
      deps(),
    );
    expect(out).toContain("project scope only");
  });

  it("persists an MCP server without accepting secret values", async () => {
    const writes: Array<{ key: string; value: unknown; cwd: string }> = [];
    const changed: string[] = [];
    const cwd = process.cwd();
    setCapabilityChangedSink(() => changed.push("changed"));
    const out = await installCapabilityWithDeps(
      {
        kind: "mcp",
        scope: "project",
        name: "docs",
        transport: "streamable-http",
        url: "https://example.com/mcp",
        bearer_token_env_var: "DOCS_TOKEN",
        env_headers: { "X-Tenant": "DOCS_TENANT" },
        allowed_tools: ["search", "read"],
        disabled_tools: ["delete"],
      },
      ctx(cwd),
      deps({
        makeSettingsManager: () =>
          ({
            getForScope: () => ({}),
            saveProjectSetting: (key: string, value: unknown, cwd: string) =>
              writes.push({ key, value, cwd }),
          }) as unknown as SettingsManager,
      }),
    );
    expect(writes).toEqual([
      {
        key: "mcpServers.docs",
        value: {
          url: "https://example.com/mcp",
          transport: "streamable-http",
          bearerTokenEnvVar: "DOCS_TOKEN",
          envHeaders: { "X-Tenant": "DOCS_TENANT" },
          allowedTools: ["search", "read"],
          disabledTools: ["delete"],
          enabled: true,
        },
        cwd,
      },
    ]);
    expect(changed).toEqual(["changed"]);
    expect(out).toContain('Installed MCP server "docs"');
  });

  it("persists local MCP servers in the machine-private project layer", async () => {
    const writes: Array<{ key: string; value: unknown; cwd: string }> = [];
    const cwd = process.cwd();
    const out = await installCapabilityWithDeps(
      {
        kind: "mcp",
        scope: "local",
        name: "private-docs",
        command: "npx",
        args: ["--yes", "private-docs-mcp"],
      },
      ctx(cwd),
      deps({
        makeSettingsManager: () =>
          ({
            getForScope: () => ({}),
            saveLocalSetting: (key: string, value: unknown, cwd: string) =>
              writes.push({ key, value, cwd }),
          }) as unknown as SettingsManager,
      }),
    );
    expect(writes).toEqual([
      {
        key: "mcpServers.private-docs",
        value: {
          command: "npx",
          args: ["--yes", "private-docs-mcp"],
          transport: "stdio",
          enabled: true,
        },
        cwd,
      },
    ]);
    expect(out).toContain("private local settings");
  });

  it("lists, inspects with secret redaction, disables, and uninstalls MCP configuration", async () => {
    const servers: Record<string, Record<string, unknown>> = {
      docs: {
        url: "https://user:secret@example.com/mcp",
        transport: "streamable-http",
        headers: { Authorization: "Bearer secret" },
        envHeaders: { "X-Token": "DOCS_TOKEN" },
        enabled: true,
      },
    };
    const writes: string[] = [];
    const lifecycleDeps = deps({
      makeSettingsManager: () =>
        ({
          getForScope: (scope: string) => (scope === "project" ? { mcpServers: servers } : {}),
          saveProjectSetting: (key: string, value: unknown) => {
            expect(key).toBe("mcpServers.docs.enabled");
            servers.docs = { ...servers.docs, enabled: value };
            writes.push(`save:${key}:${String(value)}`);
          },
          deleteProjectSetting: (key: string) => {
            expect(key).toBe("mcpServers.docs");
            delete servers.docs;
            writes.push(`delete:${key}`);
          },
        }) as unknown as SettingsManager,
    });
    const listed = await installCapabilityWithDeps(
      { action: "list", kind: "mcp" },
      ctx(),
      lifecycleDeps,
    );
    const inspected = await installCapabilityWithDeps(
      { action: "inspect", kind: "mcp", name: "docs" },
      ctx(),
      lifecycleDeps,
    );
    const disabled = await installCapabilityWithDeps(
      { action: "disable", kind: "mcp", name: "docs" },
      ctx(),
      lifecycleDeps,
    );
    const removed = await installCapabilityWithDeps(
      { action: "uninstall", kind: "mcp", name: "docs" },
      ctx(),
      lifecycleDeps,
    );
    expect(listed).toContain("docs [project]");
    expect(inspected).toContain("https://example.com/mcp");
    expect(inspected).toContain("Static header names: Authorization (values hidden)");
    expect(inspected).not.toContain("secret");
    expect(disabled).toContain('Disabled MCP server "docs"');
    expect(removed).toContain('Uninstalled MCP server "docs"');
    expect(writes).toEqual(["save:mcpServers.docs.enabled:false", "delete:mcpServers.docs"]);
    expect(servers).toEqual({});
  });

  it("requires replace=true before overwriting an MCP server", async () => {
    const out = await installCapabilityWithDeps(
      { kind: "mcp", name: "docs", command: "npx", args: ["server"] },
      ctx(),
      deps({
        makeSettingsManager: () =>
          ({
            getForScope: () => ({ mcpServers: { docs: { command: "old" } } }),
            saveProjectSetting: () => {
              throw new Error("must not write");
            },
          }) as unknown as SettingsManager,
      }),
    );
    expect(out).toContain("already exists");
    expect(out).toContain("replace=true");
  });

  it("rejects embedded HTTP credentials and inline control characters", async () => {
    const secretUrl = await installCapabilityWithDeps(
      {
        kind: "mcp",
        name: "bad",
        url: "https://user:password@example.com/mcp",
      },
      ctx(),
      deps(),
    );
    expect(secretUrl).toContain("without embedded credentials");

    const command = await installCapabilityWithDeps(
      { kind: "mcp", name: "bad", command: "npx\nrm" },
      ctx(),
      deps(),
    );
    expect(command).toContain("valid executable");

    const inlineToken = await installCapabilityWithDeps(
      {
        kind: "mcp",
        name: "bad",
        command: "npx",
        args: ["server", "--token=plain-secret"],
      },
      ctx(),
      deps(),
    );
    expect(inlineToken).toContain("inline credential");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  pluginHookDecisionSucceeded,
  pluginTrustDecisionSucceeded,
  runPluginCommand,
} from "../packages/tui/src/cli/commands/builtin/plugin-handler.js";
import { readInstalledPlugins } from "../packages/core/src/plugins/installedPlugins.js";
import { loadPluginAutomationTemplateContributions } from "../packages/core/src/plugins/pluginCatalog.js";
import { pluginHooksDigest } from "../packages/core/src/plugins/pluginHookIntegrity.js";
import { pluginMcpDigest } from "../packages/core/src/plugins/pluginMcpIntegrity.js";
import { CronScheduler } from "@cjhyy/code-shell-core/internal";

function bareRepoWithFiles(scratch: string, name: string, files: Record<string, string>): string {
  const work = join(scratch, `${name}-work`);
  mkdirSync(work, { recursive: true });
  spawnSync("git", ["init", "-q", work]);
  spawnSync("git", ["-C", work, "config", "user.email", "t@t"]);
  spawnSync("git", ["-C", work, "config", "user.name", "T"]);
  for (const [rel, contents] of Object.entries(files)) {
    const target = join(work, rel);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents);
  }
  spawnSync("git", ["-C", work, "add", "."]);
  spawnSync("git", ["-C", work, "commit", "-q", "-m", "init"]);
  const bare = join(scratch, `${name}.git`);
  spawnSync("git", ["clone", "--bare", "-q", work, bare]);
  rmSync(work, { recursive: true, force: true });
  return bare;
}

describe("/plugin command", () => {
  let fakeHome: string;
  let originalHome: string | undefined;
  let scratch: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "plugin-cmd-home-"));
    scratch = mkdtempSync(join(tmpdir(), "plugin-cmd-fixture-"));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  it("no args prints usage", async () => {
    const out = await runPluginCommand("");
    expect(out).toContain("Usage:");
    expect(out).toContain("/plugin marketplace add");
  });

  it("unknown subcommand prints usage", async () => {
    const out = await runPluginCommand("foobar");
    expect(out).toContain("Unknown subcommand");
    expect(out).toContain("Usage:");
  });

  it("marketplace list shows empty state", async () => {
    const out = await runPluginCommand("marketplace list");
    expect(out).toContain("No marketplaces");
  });

  it("marketplace add succeeds and lists plugins", async () => {
    const bare = bareRepoWithFiles(scratch, "src", {
      ".claude-plugin/marketplace.json": JSON.stringify({
        name: "fixture",
        owner: { name: "T" },
        plugins: [{ name: "alpha", description: "the alpha plugin", source: "./alpha" }],
      }),
      "alpha/skills/hello/SKILL.md": "---\ndescription: hi\n---\nbody",
    });
    const out = await runPluginCommand(`marketplace add ${bare}`);
    expect(out).toContain("Added marketplace");
    expect(out).toContain("alpha");
    expect(out).toContain("the alpha plugin");
  });

  it("marketplace add rejects invalid input", async () => {
    const out = await runPluginCommand("marketplace add random-not-a-url");
    expect(out).toContain("Cannot parse");
  });

  it("marketplace remove handles missing name", async () => {
    const out = await runPluginCommand("marketplace remove ghost");
    expect(out).toContain("not found");
  });

  it("install + list + uninstall round trip", async () => {
    const bare = bareRepoWithFiles(scratch, "src", {
      ".claude-plugin/marketplace.json": JSON.stringify({
        name: "fixture",
        owner: { name: "T" },
        plugins: [{ name: "alpha", source: "./alpha" }],
      }),
      "alpha/skills/hello/SKILL.md": "---\ndescription: hi\n---\nbody",
    });
    const add = await runPluginCommand(`marketplace add ${bare}`);
    expect(add).toContain("Added marketplace");

    // derive marketplace name from URL: last segment of "/path/to/src.git" → "src"
    const inst = await runPluginCommand("install alpha@src");
    expect(inst).toContain("Installed alpha@src");

    const list = await runPluginCommand("list");
    expect(list).toContain("alpha@src");

    const uninst = await runPluginCommand("uninstall alpha@src");
    expect(uninst).toContain("Uninstalled alpha@src");
  });

  it("install rejects malformed key", async () => {
    const out = await runPluginCommand("install just-a-name");
    expect(out).toContain("Expected <plugin>@<marketplace>");
  });

  it("install reports marketplace not found", async () => {
    const out = await runPluginCommand("install alpha@nowhere");
    expect(out).toContain("not found");
  });

  it("lists, approves, and revokes plugin hooks", async () => {
    const installPath = join(fakeHome, ".code-shell", "plugins", "demo");
    mkdirSync(join(installPath, "hooks"), { recursive: true });
    writeFileSync(
      join(installPath, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo demo" }] }],
        },
      }),
    );
    mkdirSync(join(fakeHome, ".code-shell", "plugins"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".code-shell", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "demo@local": [
            {
              scope: "user",
              installPath,
              version: "1.0.0",
              installedAt: "t1",
              lastUpdated: "t1",
              hookDigest: pluginHooksDigest(installPath),
            },
          ],
        },
      }),
    );

    expect(await runPluginCommand("hooks list")).toContain("demo@local  [pending]");
    expect(await runPluginCommand("hooks diff demo")).toContain(
      "baseline: none (first approval; every command is new)",
    );
    expect(await runPluginCommand("hooks diff demo")).toContain("+ SessionStart");
    expect(await runPluginCommand("hooks approve demo")).toContain(
      "Approved hooks for demo@local [approved]",
    );
    expect(await runPluginCommand("hooks diff demo")).toContain("= SessionStart");
    expect(readInstalledPlugins().plugins["demo@local"]?.[0]?.approvedHookDigest).toBeDefined();
    expect(await runPluginCommand("hooks revoke demo@local")).toContain(
      "Revoked hooks for demo@local [pending]",
    );
    expect(readInstalledPlugins().plugins["demo@local"]?.[0]?.approvedHookDigest).toBeUndefined();
  });

  it("requests a runtime reload only after a successful hook decision", () => {
    expect(
      pluginHookDecisionSucceeded(
        "hooks approve demo@local",
        "Approved hooks for demo@local [approved]",
      ),
    ).toBe(true);
    expect(
      pluginHookDecisionSucceeded(
        "hooks revoke demo@local",
        "Failed to revoke hooks for demo@local: not installed",
      ),
    ).toBe(false);
    expect(pluginHookDecisionSucceeded("hooks list", "Plugin hooks (1):")).toBe(false);
  });

  it("lists, approves, and revokes plugin MCP trust", async () => {
    const installPath = join(fakeHome, ".code-shell", "plugins", "demo");
    mkdirSync(installPath, { recursive: true });
    writeFileSync(
      join(installPath, "mcp-servers.json"),
      JSON.stringify({ "demo:server": { command: "demo-mcp", name: "demo:server" } }),
    );
    mkdirSync(join(fakeHome, ".code-shell", "plugins"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".code-shell", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "demo@local": [
            {
              scope: "user",
              installPath,
              version: "1.0.0",
              installedAt: "t1",
              lastUpdated: "t1",
              mcpDigest: pluginMcpDigest(installPath),
            },
          ],
        },
      }),
    );

    expect(await runPluginCommand("mcp list")).toContain("demo@local  [pending]");
    expect(await runPluginCommand("mcp approve demo")).toContain(
      "Approved MCP for demo@local [approved]",
    );
    expect(readInstalledPlugins().plugins["demo@local"]?.[0]?.approvedMcpDigest).toBeDefined();
    expect(await runPluginCommand("mcp disable demo:server", scratch)).toBe(
      "Disabled MCP server demo:server",
    );
    expect(
      JSON.parse(readFileSync(join(fakeHome, ".code-shell", "settings.json"), "utf-8"))
        .mcpServerOverrides["demo:server"].enabled,
    ).toBe(false);
    expect(await runPluginCommand("mcp enable demo:server", scratch)).toBe(
      "Enabled MCP server demo:server",
    );
    expect(await runPluginCommand("mcp allow demo:server search read", scratch)).toContain(
      "Allowed only 2 MCP tool(s)",
    );
    expect(await runPluginCommand("mcp deny demo:server delete publish", scratch)).toContain(
      "Denied 2 MCP tool(s)",
    );
    expect(await runPluginCommand("mcp tools demo:server", scratch)).toBe(
      [
        "MCP tool policy for demo:server:",
        "  allow: search, read",
        "  deny:  delete, publish",
      ].join("\n"),
    );
    let override = JSON.parse(readFileSync(join(fakeHome, ".code-shell", "settings.json"), "utf-8"))
      .mcpServerOverrides["demo:server"];
    expect(override.allowedTools).toEqual(["search", "read"]);
    expect(override.disabledTools).toEqual(["delete", "publish"]);
    expect(await runPluginCommand("mcp tools-reset demo:server", scratch)).toBe(
      "Reset MCP tool policy for demo:server",
    );
    override = JSON.parse(readFileSync(join(fakeHome, ".code-shell", "settings.json"), "utf-8"))
      .mcpServerOverrides["demo:server"];
    expect(override.enabled).toBe(true);
    expect(override.allowedTools).toBeUndefined();
    expect(override.disabledTools).toBeUndefined();
    expect(await runPluginCommand("mcp revoke demo@local")).toContain(
      "Revoked MCP for demo@local [pending]",
    );
    expect(readInstalledPlugins().plugins["demo@local"]?.[0]?.approvedMcpDigest).toBeUndefined();
  });

  it("requests a runtime reload only after a successful MCP decision", () => {
    expect(
      pluginTrustDecisionSucceeded(
        "mcp approve demo@local",
        "Approved MCP for demo@local [approved]",
      ),
    ).toBe(true);
    expect(
      pluginTrustDecisionSucceeded(
        "mcp revoke demo@local",
        "Failed to revoke MCP for demo@local: not installed",
      ),
    ).toBe(false);
    expect(pluginTrustDecisionSucceeded("mcp list", "Plugin MCP trust (1):")).toBe(false);
    expect(
      pluginTrustDecisionSucceeded("mcp disable demo:server", "Disabled MCP server demo:server"),
    ).toBe(true);
    expect(
      pluginTrustDecisionSucceeded(
        "mcp enable missing:server",
        "Failed to enable MCP server missing:server: server is not installed",
      ),
    ).toBe(false);
    expect(
      pluginTrustDecisionSucceeded(
        "mcp allow demo:server read search",
        "Allowed only 2 MCP tool(s) for demo:server: read, search",
      ),
    ).toBe(true);
    expect(
      pluginTrustDecisionSucceeded(
        "mcp allow demo:server",
        "Failed to set MCP tool policy for demo:server: at least one exact MCP tool name is required",
      ),
    ).toBe(false);
  });

  it("reviews and explicitly instantiates plugin automation templates", async () => {
    const installPath = join(fakeHome, ".code-shell", "plugins", "automation-demo");
    mkdirSync(installPath, { recursive: true });
    writeFileSync(
      join(installPath, ".cs-plugin-manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "automation-demo",
        version: "1.0.0",
        automations: {
          version: 1,
          templates: [
            {
              id: "daily-review",
              title: { default: "Daily review" },
              schedule: "0 9 * * *",
              prompt: "Inspect pending work without changing files.",
              permissionLevel: "read-only",
              workspace: "current",
            },
          ],
        },
      }),
    );
    writeFileSync(
      join(fakeHome, ".code-shell", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "automation-demo@local": [
            {
              scope: "user",
              installPath,
              version: "1.0.0",
              installedAt: "t1",
              lastUpdated: "t1",
            },
          ],
        },
      }),
    );
    const contribution = loadPluginAutomationTemplateContributions()[0]!;
    const automationScheduler = new CronScheduler();
    automationScheduler.setExecutionEnabled(false);
    const options = { automationScheduler };

    expect(await runPluginCommand("automations list", scratch, options)).toContain(
      contribution.revision,
    );
    const review = await runPluginCommand(
      "automations show automation-demo@local daily-review",
      scratch,
      options,
    );
    expect(review).toContain("Inspect pending work without changing files.");
    expect(review).toContain(contribution.revision);

    const unconfirmed = await runPluginCommand(
      "automations create automation-demo@local daily-review",
      scratch,
      options,
    );
    expect(unconfirmed).toContain("Not created");
    expect(automationScheduler.list()).toHaveLength(0);

    const created = await runPluginCommand(
      `automations create automation-demo@local daily-review --revision ${contribution.revision} --confirm`,
      scratch,
      options,
    );
    expect(created).toContain("Created automation");
    const createdId = /^Created automation (\S+)/u.exec(created)?.[1];
    const job = createdId ? automationScheduler.get(createdId) : undefined;
    expect(job).toMatchObject({
      cwd: scratch,
      permissionLevel: "read-only",
      templateSource: {
        installKey: "automation-demo@local",
        templateId: "daily-review",
        revision: contribution.revision,
      },
    });
    automationScheduler.stopAll();
  });
});

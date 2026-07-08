import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installPluginFromPath } from "./install.js";
import { readInstalledPlugins } from "../installedPlugins.js";

const STAMP = "2026-05-29T10:00:00Z";

describe("installPluginFromPath", () => {
  let home: string, src: string, prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-home-"));
    src = mkdtempSync(join(tmpdir(), "cs-src-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  test("installs a CC plugin: copies dir + writes cc meta", async () => {
    mkdirSync(join(src, "skills", "s"), { recursive: true });
    writeFileSync(join(src, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nb");
    const dir = await installPluginFromPath(src, "ccplug", STAMP);
    expect(existsSync(join(dir, "skills", "s", "SKILL.md"))).toBe(true);
    const meta = JSON.parse(readFileSync(join(dir, ".cs-meta.json"), "utf-8"));
    expect(meta).toMatchObject({ name: "ccplug", format: "cc", source: src, installedAt: STAMP });
  });

  test("CC plugin: records the version from .claude-plugin/plugin.json (not 'local')", async () => {
    mkdirSync(join(src, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(src, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "verplug", version: "0.1.0", description: "d" }),
    );
    mkdirSync(join(src, "skills", "s"), { recursive: true });
    writeFileSync(join(src, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nb");
    await installPluginFromPath(src, "verplug", STAMP);
    const installed = readInstalledPlugins();
    const entry = installed.plugins["verplug@local"]?.[0];
    expect(entry?.version).toBe("0.1.0");
  });

  test("CC plugin without a manifest version records no version (falls back to source tag)", async () => {
    mkdirSync(join(src, "skills", "s"), { recursive: true });
    writeFileSync(join(src, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nb");
    await installPluginFromPath(src, "noverplug", STAMP);
    const installed = readInstalledPlugins();
    const entry = installed.plugins["noverplug@local"]?.[0];
    // appendInstallEntry falls back to "local" when meta.version is undefined.
    expect(entry?.version).toBe("local");
  });

  test("rewrites CLAUDE_PLUGIN_ROOT placeholders in the installed local copy", async () => {
    mkdirSync(join(src, "skills", "s"), { recursive: true });
    writeFileSync(join(src, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nb");
    mkdirSync(join(src, "hooks"), { recursive: true });
    writeFileSync(
      join(src, "hooks", "hooks.json"),
      JSON.stringify({
        SessionStart: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/run" }] }],
      }),
    );
    const dir = await installPluginFromPath(src, "rewriteplug", STAMP);

    const installedHooks = readFileSync(join(dir, "hooks", "hooks.json"), "utf-8");
    expect(installedHooks).toContain("${CODESHELL_PLUGIN_ROOT}/run");
    expect(installedHooks).not.toContain("CLAUDE_PLUGIN_ROOT");
    expect(existsSync(join(dir, ".code-shell-installed.json"))).toBe(true);
  });

  test("installs a Codex plugin: converts agent + writes mcp-servers.json + codex meta", async () => {
    mkdirSync(join(src, ".codex-plugin"), { recursive: true });
    writeFileSync(
      join(src, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "cx", version: "2.0.0", mcpServers: { fs: { command: "f" } } }),
    );
    mkdirSync(join(src, "agents"), { recursive: true });
    writeFileSync(join(src, "agents", "r.toml"), 'name = "r"\ndescription = "d"\nmodel = "flash"');
    mkdirSync(join(src, "prompts"), { recursive: true });
    writeFileSync(join(src, "prompts", "draftpr.md"), "---\ndescription: draft a PR\n---\nDraft $1");
    const dir = await installPluginFromPath(src, "cx", STAMP);
    const md = readFileSync(join(dir, "agents", "r.md"), "utf-8");
    expect(md).toContain("name: r");
    expect(md).toContain("model: flash");
    // Codex prompts → CC commands/ so pluginCommandsLoader picks them up.
    expect(existsSync(join(dir, "commands", "draftpr.md"))).toBe(true);
    const mcp = JSON.parse(readFileSync(join(dir, "mcp-servers.json"), "utf-8"));
    expect(mcp["cx:fs"]).toMatchObject({ command: "f", name: "cx:fs" });
    const meta = JSON.parse(readFileSync(join(dir, ".cs-meta.json"), "utf-8"));
    expect(meta).toMatchObject({ name: "cx", format: "codex", version: "2.0.0" });
  });

  test("refuses when install dir already exists", async () => {
    mkdirSync(join(home, ".code-shell", "plugins", "dup"), { recursive: true });
    await expect(installPluginFromPath(src, "dup", STAMP)).rejects.toThrow(/already installed/);
  });

  test("registers the install in installed_plugins.json", async () => {
    mkdirSync(join(src, "skills", "s"), { recursive: true });
    writeFileSync(join(src, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nb");
    const dir = await installPluginFromPath(src, "regplug", STAMP);
    const reg = readInstalledPlugins();
    const entry = reg.plugins["regplug@local"]?.[0];
    expect(entry?.installPath).toBe(dir);
    expect(entry?.version).toBeDefined();
  });

  test("leaves no install dir when conversion fails", async () => {
    mkdirSync(join(src, ".codex-plugin"), { recursive: true });
    writeFileSync(join(src, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "x", version: "1" }));
    mkdirSync(join(src, "agents"), { recursive: true });
    writeFileSync(join(src, "agents", "bad.toml"), 'description = "no name"');
    await expect(installPluginFromPath(src, "x", STAMP)).rejects.toThrow(/name/);
    expect(existsSync(join(home, ".code-shell", "plugins", "x"))).toBe(false);
  });
});

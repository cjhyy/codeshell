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

  test("installs a CC plugin: copies dir + writes cc meta", () => {
    mkdirSync(join(src, "skills", "s"), { recursive: true });
    writeFileSync(join(src, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nb");
    const dir = installPluginFromPath(src, "ccplug", STAMP);
    expect(existsSync(join(dir, "skills", "s", "SKILL.md"))).toBe(true);
    const meta = JSON.parse(readFileSync(join(dir, ".cs-meta.json"), "utf-8"));
    expect(meta).toMatchObject({ name: "ccplug", format: "cc", source: src, installedAt: STAMP });
  });

  test("installs a Codex plugin: converts agent + writes mcp-servers.json + codex meta", () => {
    mkdirSync(join(src, ".codex-plugin"), { recursive: true });
    writeFileSync(
      join(src, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "cx", version: "2.0.0", mcpServers: { fs: { command: "f" } } }),
    );
    mkdirSync(join(src, "agents"), { recursive: true });
    writeFileSync(join(src, "agents", "r.toml"), 'name = "r"\ndescription = "d"\nmodel = "flash"');
    const dir = installPluginFromPath(src, "cx", STAMP);
    const md = readFileSync(join(dir, "agents", "r.md"), "utf-8");
    expect(md).toContain("name: r");
    expect(md).toContain("model: flash");
    const mcp = JSON.parse(readFileSync(join(dir, "mcp-servers.json"), "utf-8"));
    expect(mcp["cx:fs"]).toMatchObject({ command: "f", name: "cx:fs" });
    const meta = JSON.parse(readFileSync(join(dir, ".cs-meta.json"), "utf-8"));
    expect(meta).toMatchObject({ name: "cx", format: "codex", version: "2.0.0" });
  });

  test("refuses when install dir already exists", () => {
    mkdirSync(join(home, ".code-shell", "plugins", "dup"), { recursive: true });
    expect(() => installPluginFromPath(src, "dup", STAMP)).toThrow(/already installed/);
  });

  test("registers the install in installed_plugins.json", () => {
    mkdirSync(join(src, "skills", "s"), { recursive: true });
    writeFileSync(join(src, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nb");
    const dir = installPluginFromPath(src, "regplug", STAMP);
    const reg = readInstalledPlugins();
    const entry = reg.plugins["regplug@local"]?.[0];
    expect(entry?.installPath).toBe(dir);
    expect(entry?.version).toBeDefined();
  });

  test("leaves no install dir when conversion fails", () => {
    mkdirSync(join(src, ".codex-plugin"), { recursive: true });
    writeFileSync(join(src, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "x", version: "1" }));
    mkdirSync(join(src, "agents"), { recursive: true });
    writeFileSync(join(src, "agents", "bad.toml"), 'description = "no name"');
    expect(() => installPluginFromPath(src, "x", STAMP)).toThrow(/name/);
    expect(existsSync(join(home, ".code-shell", "plugins", "x"))).toBe(false);
  });
});

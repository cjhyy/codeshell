import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { updatePluginByName } from "./update.js";
import { installPluginFromPath } from "./install.js";
import { installPluginFromSource } from "./installFromSource.js";
import { parseSource } from "./parseSource.js";
import { PluginInstallError } from "./types.js";

/** Any leftover backup dirs (`.bak-*`) in the plugins root — must be empty after both success and failure. */
function leftoverBaks(home: string): string[] {
  const root = join(home, ".code-shell", "plugins");
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((n) => n.includes(".bak-"));
}

describe("updatePluginByName", () => {
  let home: string, src: string, prev: string | undefined;
  beforeEach(async () => {
    prev = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-up-home-"));
    src = mkdtempSync(join(tmpdir(), "cs-up-src-"));
    process.env.HOME = home;
    mkdirSync(join(src, ".codex-plugin"), { recursive: true });
    writeFileSync(join(src, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "u", version: "1.0.0" }));
    mkdirSync(join(src, "agents"), { recursive: true });
    writeFileSync(join(src, "agents", "a.toml"), 'name = "a"\ndescription = "d"');
    await installPluginFromPath(src, "u", "t1");
  });
  afterEach(() => {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  test("no-op when version unchanged", async () => {
    const r = await updatePluginByName("u", "t2", false);
    expect(r.updated).toBe(false);
  });

  test("reinstalls when source version bumped", async () => {
    writeFileSync(join(src, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "u", version: "2.0.0" }));
    const r = await updatePluginByName("u", "t2", false);
    expect(r.updated).toBe(true);
    const meta = JSON.parse(readFileSync(join(home, ".code-shell", "plugins", "u", ".cs-meta.json"), "utf-8"));
    expect(meta.version).toBe("2.0.0");
  });

  test("force reinstalls even when unchanged", async () => {
    const r = await updatePluginByName("u", "t2", true);
    expect(r.updated).toBe(true);
  });

  test("a failed reinstall is atomic: old plugin is kept, error says so", async () => {
    const installed = join(home, ".code-shell", "plugins", "u");
    const metaPath = join(installed, ".cs-meta.json");
    const before = readFileSync(metaPath, "utf-8");
    // Corrupt the source so installPluginFromPath fails during the reinstall.
    writeFileSync(join(src, ".codex-plugin", "plugin.json"), "{ not valid json");

    await expect(updatePluginByName("u", "t2", true)).rejects.toThrow(PluginInstallError);
    // The OLD version must still be intact (dir + meta + converted agent file).
    expect(existsSync(installed)).toBe(true);
    expect(existsSync(metaPath)).toBe(true);
    expect(readFileSync(metaPath, "utf-8")).toBe(before);
    expect(existsSync(join(installed, "agents", "a.md"))).toBe(true);
    // No backup dir leftover in the plugins root.
    expect(leftoverBaks(home).length).toBe(0);
  });

  test("a failed reinstall error mentions the old version was kept (not removed)", async () => {
    writeFileSync(join(src, ".codex-plugin", "plugin.json"), "{ not valid json");
    await expect(updatePluginByName("u", "t2", true)).rejects.toThrow(/\bkept\b/);
    await expect(updatePluginByName("u", "t2", true)).rejects.not.toThrow(/was removed/);
  });

  test("a successful reinstall leaves the new version and no .bak leftover", async () => {
    writeFileSync(join(src, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "u", version: "3.0.0" }));
    const r = await updatePluginByName("u", "t2", false);
    expect(r.updated).toBe(true);
    const meta = JSON.parse(readFileSync(join(home, ".code-shell", "plugins", "u", ".cs-meta.json"), "utf-8"));
    expect(meta.version).toBe("3.0.0");
    expect(leftoverBaks(home).length).toBe(0);
  });
});

describe("updatePluginByName (remote source)", () => {
  let home: string, repo: string, prev: string | undefined;
  beforeEach(() => {
    prev = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-upr-home-"));
    repo = mkdtempSync(join(tmpdir(), "cs-upr-repo-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  test("re-clones a remote-sourced plugin (always reinstalls)", async () => {
    mkdirSync(join(repo, "skills", "s"), { recursive: true });
    writeFileSync(join(repo, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nv1");
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
    const run = (args: string[]) => execFileSync("git", args, { cwd: repo, env, stdio: "pipe" });
    run(["init", "-q"]);
    run(["config", "user.email", "t@t.t"]);
    run(["config", "user.name", "t"]);
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "init"]);

    const raw = `file://${repo}`;
    await installPluginFromSource(parseSource(raw), "rem", "t1");

    // bump the repo content + commit
    writeFileSync(join(repo, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nv2");
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "bump"]);

    const r = await updatePluginByName("rem", "t2", false);
    expect(r.updated).toBe(true);
    const body = readFileSync(join(home, ".code-shell", "plugins", "rem", "skills", "s", "SKILL.md"), "utf-8");
    expect(body).toContain("v2");
    // source string preserved across re-clone
    const meta = JSON.parse(readFileSync(join(home, ".code-shell", "plugins", "rem", ".cs-meta.json"), "utf-8"));
    expect(meta.source).toBe(raw);
    expect(existsSync(join(home, ".code-shell", "plugins", "rem"))).toBe(true);
  });

  test("a failed remote reinstall is atomic: old clone is restored", async () => {
    mkdirSync(join(repo, "skills", "s"), { recursive: true });
    writeFileSync(join(repo, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nv1");
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
    const run = (args: string[]) => execFileSync("git", args, { cwd: repo, env, stdio: "pipe" });
    run(["init", "-q"]);
    run(["config", "user.email", "t@t.t"]);
    run(["config", "user.name", "t"]);
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "init"]);

    const raw = `file://${repo}`;
    await installPluginFromSource(parseSource(raw), "rem", "t1");
    const installed = join(home, ".code-shell", "plugins", "rem");
    const skillBefore = readFileSync(join(installed, "skills", "s", "SKILL.md"), "utf-8");

    // Destroy the repo so the re-clone fails during the reinstall.
    rmSync(repo, { recursive: true, force: true });

    await expect(updatePluginByName("rem", "t2", false)).rejects.toThrow(PluginInstallError);
    // OLD remote install must still be intact and unchanged.
    expect(existsSync(installed)).toBe(true);
    expect(existsSync(join(installed, ".cs-meta.json"))).toBe(true);
    expect(readFileSync(join(installed, "skills", "s", "SKILL.md"), "utf-8")).toBe(skillBefore);
    const root = join(home, ".code-shell", "plugins");
    expect(readdirSync(root).filter((n) => n.includes(".bak-")).length).toBe(0);
  });
});

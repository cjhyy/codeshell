import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { installPluginFromSource } from "./installFromSource.js";
import { parseSource } from "./parseSource.js";
import { readInstalledPlugins } from "../installedPlugins.js";

const STAMP = "2026-05-29T10:00:00Z";

/** Init a git repo at dir with one commit. */
function gitInitCommit(dir: string): void {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, env, stdio: "pipe" });
  run(["init", "-q"]);
  run(["config", "user.email", "t@t.t"]);
  run(["config", "user.name", "t"]);
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "init"]);
}

describe("installPluginFromSource", () => {
  let home: string, repo: string, prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-home-"));
    repo = mkdtempSync(join(tmpdir(), "cs-repo-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  test("clones a CC plugin repo and installs it, source = original git string", async () => {
    mkdirSync(join(repo, "skills", "s"), { recursive: true });
    writeFileSync(join(repo, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nb");
    gitInitCommit(repo);

    const raw = `file://${repo}`;
    const parsed = parseSource(raw);
    const dir = await installPluginFromSource(parsed, "remoteplug", STAMP);

    expect(existsSync(join(dir, "skills", "s", "SKILL.md"))).toBe(true);
    const meta = JSON.parse(readFileSync(join(dir, ".cs-meta.json"), "utf-8"));
    expect(meta.source).toBe(raw); // original git string, NOT /tmp clone path
    expect(meta.name).toBe("remoteplug");

    const reg = readInstalledPlugins();
    expect(reg.plugins["remoteplug@local"]?.[0]?.installPath).toBe(dir);

    // no leftover temp clone dirs in plugins root
    const leftovers = readdirSync(join(home, ".code-shell", "plugins")).filter((n) => n.startsWith(".tmp-clone"));
    expect(leftovers).toEqual([]);
  });

  test("installs from a subdir of the repo", async () => {
    mkdirSync(join(repo, "sub", "myplugin", "skills", "s"), { recursive: true });
    writeFileSync(
      join(repo, "sub", "myplugin", "skills", "s", "SKILL.md"),
      "---\nname: s\ndescription: d\n---\nb",
    );
    gitInitCommit(repo);

    const raw = `file://${repo}#sub/myplugin`;
    const parsed = parseSource(raw);
    const dir = await installPluginFromSource(parsed, "subplug", STAMP);

    expect(existsSync(join(dir, "skills", "s", "SKILL.md"))).toBe(true);
    const meta = JSON.parse(readFileSync(join(dir, ".cs-meta.json"), "utf-8"));
    expect(meta.source).toBe(raw);
  });

  test("errors when subdir does not exist, leaves no install dir", async () => {
    mkdirSync(join(repo, "skills", "s"), { recursive: true });
    writeFileSync(join(repo, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nb");
    gitInitCommit(repo);

    const parsed = parseSource(`file://${repo}#nope/here`);
    await expect(installPluginFromSource(parsed, "x", STAMP)).rejects.toThrow(/subdir not found/);
    expect(existsSync(join(home, ".code-shell", "plugins", "x"))).toBe(false);
  });

  test("errors on clone failure, leaves nothing", async () => {
    const parsed = parseSource(`file://${repo}-does-not-exist`);
    await expect(installPluginFromSource(parsed, "x", STAMP)).rejects.toThrow();
    expect(existsSync(join(home, ".code-shell", "plugins", "x"))).toBe(false);
  });

  test("rejects a local ParsedSource (orchestrator is remote-only)", async () => {
    const parsed = parseSource("./somewhere");
    await expect(installPluginFromSource(parsed, "x", STAMP)).rejects.toThrow();
  });
});

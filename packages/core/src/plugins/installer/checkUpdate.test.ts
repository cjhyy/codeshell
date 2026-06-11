import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { checkPluginUpdate } from "./checkUpdate.js";
import { installPluginFromPath } from "./install.js";
import { installPluginFromSource } from "./installFromSource.js";
import { parseSource } from "./parseSource.js";
import { PluginInstallError } from "./types.js";

function metaPath(home: string, name: string): string {
  return join(home, ".code-shell", "plugins", name, ".cs-meta.json");
}

describe("checkPluginUpdate", () => {
  let home: string, repo: string, src: string, prev: string | undefined;
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

  beforeEach(() => {
    prev = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-chk-home-"));
    repo = mkdtempSync(join(tmpdir(), "cs-chk-repo-"));
    src = mkdtempSync(join(tmpdir(), "cs-chk-src-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  function makeRepo(): { run: (args: string[]) => Buffer } {
    mkdirSync(join(repo, "skills", "s"), { recursive: true });
    writeFileSync(join(repo, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nv1");
    const run = (args: string[]) => execFileSync("git", args, { cwd: repo, env, stdio: "pipe" });
    run(["init", "-q"]);
    run(["config", "user.email", "t@t.t"]);
    run(["config", "user.name", "t"]);
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "init"]);
    return { run };
  }

  function headSha(): string {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, env, stdio: "pipe" })
      .toString()
      .trim();
  }

  test("not-remote (local source) → updateAvailable false, reason mentions remote", async () => {
    mkdirSync(join(src, ".codex-plugin"), { recursive: true });
    writeFileSync(join(src, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "loc", version: "1.0.0" }));
    mkdirSync(join(src, "agents"), { recursive: true });
    writeFileSync(join(src, "agents", "a.toml"), 'name = "a"\ndescription = "d"');
    await installPluginFromPath(src, "loc", "t1");

    const r = await checkPluginUpdate("loc");
    expect(r.updateAvailable).toBe(false);
    expect(r.reason).toMatch(/remote/i);
  });

  test("remote + commit equal to remote HEAD → updateAvailable false", async () => {
    makeRepo();
    const raw = `file://${repo}`;
    await installPluginFromSource(parseSource(raw), "rem", "t1");

    const r = await checkPluginUpdate("rem");
    expect(r.updateAvailable).toBe(false);
    expect(r.currentCommit).toBe(headSha());
    expect(r.latestCommit).toBe(headSha());
  });

  test("remote + commit differs (HEAD moved) → updateAvailable true, latestCommit is new HEAD", async () => {
    const { run } = makeRepo();
    const raw = `file://${repo}`;
    await installPluginFromSource(parseSource(raw), "rem", "t1");
    const installed = headSha();

    // move HEAD in the source repo
    writeFileSync(join(repo, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nv2");
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "bump"]);
    const moved = headSha();

    const r = await checkPluginUpdate("rem");
    expect(r.updateAvailable).toBe(true);
    expect(r.currentCommit).toBe(installed);
    expect(r.latestCommit).toBe(moved);
  });

  test("remote + missing meta.commit → updateAvailable false, reason about no recorded commit", async () => {
    makeRepo();
    const raw = `file://${repo}`;
    await installPluginFromSource(parseSource(raw), "rem", "t1");

    // strip the recorded commit to simulate an older install
    const mp = metaPath(home, "rem");
    const meta = JSON.parse(readFileSync(mp, "utf-8"));
    delete meta.commit;
    writeFileSync(mp, JSON.stringify(meta, null, 2));

    const r = await checkPluginUpdate("rem");
    expect(r.updateAvailable).toBe(false);
    expect(r.reason).toMatch(/recorded commit/i);
  });

  test("missing plugin throws", async () => {
    await expect(checkPluginUpdate("nope")).rejects.toThrow(PluginInstallError);
  });
});

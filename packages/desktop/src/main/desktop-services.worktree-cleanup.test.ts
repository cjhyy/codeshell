import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

mock.module("electron", () => ({
  shell: {
    openExternal: async () => {},
    showItemInFolder: () => {},
    openPath: async () => "",
  },
}));

const { cleanupStaleWorktrees } = await import("./desktop-services.js");

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf-8" }).trim();
}

describe("cleanupStaleWorktrees", () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cs-desktop-stale-wt-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@t.t"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "f.txt"), "x\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init"]);
    git(repo, ["branch", "-M", "main"]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("skips external and detached worktrees while removing configured and historical managed ones", async () => {
    const worktreesDir = resolve(repo, "..", ".worktrees");
    const configuredPath = join(worktreesDir, "configured");
    const historicalPath = join(worktreesDir, "historical");
    const externalPath = join(worktreesDir, "external");
    const detachedPath = join(worktreesDir, "detached");

    git(repo, ["worktree", "add", "-b", "agent/configured", configuredPath]);
    git(repo, ["worktree", "add", "-b", "worktree/historical", historicalPath]);
    git(repo, ["worktree", "add", "-b", "external/feature", externalPath]);
    git(repo, ["worktree", "add", "--detach", detachedPath, "HEAD"]);

    const old = new Date(Date.now() - 60 * 60_000);
    for (const path of [configuredPath, historicalPath, externalPath, detachedPath]) {
      utimesSync(path, old, old);
    }

    const removed = await cleanupStaleWorktrees(repo, 1, "agent/");

    expect(removed.map((path) => basename(path)).sort()).toEqual(["configured", "historical"]);
    expect(existsSync(configuredPath)).toBe(false);
    expect(existsSync(historicalPath)).toBe(false);
    expect(existsSync(externalPath)).toBe(true);
    expect(existsSync(detachedPath)).toBe(true);
    expect(git(repo, ["branch", "--list", "agent/configured"])).toBe("");
    expect(git(repo, ["branch", "--list", "worktree/historical"])).toBe("");
    expect(git(repo, ["branch", "--list", "external/feature"])).toContain("external/feature");
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, removeWorktree } from "./crud.js";
import { getWorktreeDiff, worktreeHasUncommittedOrAheadChanges } from "./diff.js";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf-8" }).trim();
}

describe("getWorktreeDiff", () => {
  let repo: string;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cs-wt-diff-root-"));
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

  test("summarizes committed and uncommitted changes for one worktree", async () => {
    const wt = await createWorktree(repo, "feature", "session123456");
    writeFileSync(join(wt.worktreePath, "feature.txt"), "feature\n");
    git(wt.worktreePath, ["add", "-A"]);
    git(wt.worktreePath, ["commit", "-q", "-m", "feature"]);
    writeFileSync(join(wt.worktreePath, "dirty.txt"), "dirty\n");

    await expect(getWorktreeDiff(wt.worktreePath, "main")).resolves.toMatchObject({
      baseRef: "main",
      changedFiles: 2,
      aheadCommits: 1,
      hasUncommittedChanges: true,
    });
    await expect(worktreeHasUncommittedOrAheadChanges(wt.worktreePath, "main")).resolves.toBe(true);

    removeWorktree(wt.worktreePath, true);
  });
});

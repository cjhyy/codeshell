import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createWorktree, removeWorktree } from "./worktree.js";

// Regression: removeWorktree removed the worktree dir, THEN ran
// `git branch --show-current` with cwd = the now-deleted worktree path
// (review-2026-05-30). That always failed (swallowed), so removeBranch=true
// never actually deleted the branch. The branch name must be captured before
// the worktree is removed.

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf-8" }).trim();
}

describe("removeWorktree removeBranch", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "cs-wt-"));
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@t.t"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "f.txt"), "x\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init"]);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(join(repo, "..", ".worktrees"), { recursive: true, force: true });
  });

  test("removeBranch=true actually deletes the worktree/* branch", () => {
    const wt = createWorktree(repo, "feat", "abcd1234ef");
    expect(existsSync(wt.worktreePath)).toBe(true);
    // The branch exists while the worktree is checked out.
    expect(git(repo, ["branch", "--list", wt.worktreeBranch])).toContain("feat");

    removeWorktree(wt.worktreePath, true);

    expect(existsSync(wt.worktreePath)).toBe(false);
    // The branch must be gone — the whole point of removeBranch=true.
    expect(git(repo, ["branch", "--list", wt.worktreeBranch])).toBe("");
  });
});

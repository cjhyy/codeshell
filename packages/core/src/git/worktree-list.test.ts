import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createWorktree, listWorktrees, removeWorktree } from "./worktree.js";
import type { SessionWorkspace } from "../types.js";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf-8" }).trim();
}

describe("listWorktrees UI metadata", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "cs-wt-list-"));
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@t.t"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "f.txt"), "x\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init"]);
    git(repo, ["branch", "-M", "main"]);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(join(repo, "..", ".worktrees"), { recursive: true, force: true });
  });

  test("includes diff summary and session occupancy", () => {
    const wt = createWorktree(repo, "ui", "session123456");
    writeFileSync(join(wt.worktreePath, "feature.txt"), "feature\n");
    git(wt.worktreePath, ["add", "-A"]);
    git(wt.worktreePath, ["commit", "-q", "-m", "feature"]);
    writeFileSync(join(wt.worktreePath, "dirty.txt"), "dirty\n");

    const workspace: SessionWorkspace = {
      root: wt.worktreePath,
      kind: "worktree",
      worktree: {
        path: wt.worktreePath,
        branch: wt.worktreeBranch,
        baseRef: "main",
        createdBy: "codeshell",
      },
    };

    const entries = listWorktrees(repo, {
      includeDiffSummary: true,
      currentSessionId: "current-session",
      workspaceOwners: [{ sessionId: "other-session", workspace }],
    });

    const main = entries.find((entry) => entry.isMain);
    expect(main?.isMain).toBe(true);
    expect(main?.diff).toMatchObject({
      baseRef: "main",
      changedFiles: 0,
      aheadCommits: 0,
      hasUncommittedChanges: false,
    });

    const row = entries.find((entry) => entry.path === wt.worktreePath);
    expect(row?.isMain).toBe(false);
    expect(row?.diff).toMatchObject({
      baseRef: "main",
      changedFiles: 2,
      aheadCommits: 1,
      hasUncommittedChanges: true,
    });
    expect(row?.occupiedBySessionIds).toEqual(["other-session"]);
    expect(row?.occupiedByOtherSession).toBe(true);

    removeWorktree(wt.worktreePath, true);
  });
});

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { SessionManager } from "./session-manager.js";
import { createWorktree, removeWorktree } from "../git/worktree.js";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf-8" }).trim();
}

describe("SessionManager workspace resume resolution", () => {
  let repo: string;
  let sessions: string;
  let sm: SessionManager;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "cs-ws-resume-repo-"));
    sessions = mkdtempSync(join(tmpdir(), "cs-ws-resume-sessions-"));
    sm = new SessionManager(sessions);
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
    rmSync(sessions, { recursive: true, force: true });
  });

  test("restores cwd to the persisted worktree when the directory exists", () => {
    sm.create(repo, "m", "p", "resume-ok");
    const wt = createWorktree(repo, "resume-ok", "resume-ok");
    sm.setSessionWorkspace("resume-ok", {
      root: wt.worktreePath,
      kind: "worktree",
      worktree: {
        path: wt.worktreePath,
        branch: wt.worktreeBranch,
        baseRef: wt.originalBranch ?? "HEAD",
        createdBy: "codeshell",
      },
    });

    const resolved = sm.resolveSessionWorkspaceForResume("resume-ok");

    expect(resolved.ok).toBe(true);
    expect(resolved.cwd).toBe(wt.worktreePath);
    expect(resolved.workspace).toEqual(sm.getSessionWorkspace("resume-ok"));
    removeWorktree(wt.worktreePath, true);
  });

  test("blocks resume with a recreate message when the worktree dir is gone but branch exists", () => {
    sm.create(repo, "m", "p", "resume-recreate");
    const wt = createWorktree(repo, "resume-recreate", "resume-recreate");
    sm.setSessionWorkspace("resume-recreate", {
      root: wt.worktreePath,
      kind: "worktree",
      worktree: {
        path: wt.worktreePath,
        branch: wt.worktreeBranch,
        baseRef: wt.originalBranch ?? "HEAD",
        createdBy: "codeshell",
      },
    });
    removeWorktree(wt.worktreePath, false);

    const resolved = sm.resolveSessionWorkspaceForResume("resume-recreate");

    expect(resolved.ok).toBe(false);
    expect(resolved.reason).toBe("worktree_missing_branch_exists");
    expect(resolved.message).toContain(wt.worktreePath);
    expect(resolved.message).toContain(wt.worktreeBranch);
    expect(sm.getSessionWorkspace("resume-recreate")!.kind).toBe("worktree");
  });

  test("does not accept a regular file at the persisted worktree path", () => {
    sm.create(repo, "m", "p", "resume-file");
    const wt = createWorktree(repo, "resume-file", "resume-file");
    sm.setSessionWorkspace("resume-file", {
      root: wt.worktreePath,
      kind: "worktree",
      worktree: {
        path: wt.worktreePath,
        branch: wt.worktreeBranch,
        baseRef: wt.originalBranch ?? "HEAD",
        createdBy: "codeshell",
      },
    });
    removeWorktree(wt.worktreePath, false);
    writeFileSync(wt.worktreePath, "not a directory\n");

    const resolved = sm.resolveSessionWorkspaceForResume("resume-file");

    expect(resolved.ok).toBe(false);
    expect(resolved.reason).toBe("worktree_missing_branch_exists");
    expect(resolved.message).toContain("not a valid git worktree");
    expect(resolved.message).toContain(wt.worktreePath);
    expect(sm.getSessionWorkspace("resume-file")!.kind).toBe("worktree");
  });

  test("falls back to main with a clear message when the worktree dir and branch are gone", () => {
    sm.create(repo, "m", "p", "resume-main");
    const wt = createWorktree(repo, "resume-main", "resume-main");
    sm.setSessionWorkspace("resume-main", {
      root: wt.worktreePath,
      kind: "worktree",
      worktree: {
        path: wt.worktreePath,
        branch: wt.worktreeBranch,
        baseRef: wt.originalBranch ?? "HEAD",
        createdBy: "codeshell",
      },
    });
    removeWorktree(wt.worktreePath, true);

    const resolved = sm.resolveSessionWorkspaceForResume("resume-main");

    expect(resolved.ok).toBe(true);
    expect(resolved.cwd).toBe(repo);
    expect(resolved.workspace).toEqual({ root: repo, kind: "main" });
    expect(resolved.message).toContain("fell back to main");
    expect(resolved.message).toContain(wt.worktreeBranch);
    expect(sm.getSessionWorkspace("resume-main")).toEqual({ root: repo, kind: "main" });
  });
});

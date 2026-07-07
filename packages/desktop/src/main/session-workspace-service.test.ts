import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, SessionManager } from "@cjhyy/code-shell-core";
import {
  cleanupSessionWorktreeForUi,
  switchSessionWorkspaceForUi,
} from "./session-workspace-service";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf-8" }).trim();
}

describe("cleanupSessionWorktreeForUi", () => {
  let repo: string;
  let home: string;
  let oldCodeShellHome: string | undefined;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "cs-desktop-ws-repo-"));
    home = mkdtempSync(join(tmpdir(), "cs-desktop-ws-home-"));
    oldCodeShellHome = process.env.CODE_SHELL_HOME;
    process.env.CODE_SHELL_HOME = home;
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@t.t"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "f.txt"), "x\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init"]);
  });

  afterEach(() => {
    if (oldCodeShellHome === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = oldCodeShellHome;
    rmSync(repo, { recursive: true, force: true });
    rmSync(join(repo, "..", ".worktrees"), { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("discard partial branch-delete failure still moves the active session back to main", () => {
    const sessionId = "desktopbranchfail";
    const sm = new SessionManager();
    sm.create(repo, "m", "p", sessionId);
    const wt = createWorktree(repo, "desktopfail", sessionId);
    sm.setSessionWorkspace(sessionId, {
      root: wt.worktreePath,
      kind: "worktree",
      worktree: {
        path: wt.worktreePath,
        branch: wt.worktreeBranch,
        baseRef: wt.originalBranch ?? "HEAD",
        createdBy: "codeshell",
      },
    });
    const lockPath = join(repo, ".git", "refs", "heads", `${wt.worktreeBranch}.lock`);
    mkdirSync(join(repo, ".git", "refs", "heads", "worktree"), { recursive: true });
    writeFileSync(lockPath, "locked\n");

    const next = cleanupSessionWorktreeForUi(sessionId, repo, wt.worktreePath, "discard");

    expect(existsSync(wt.worktreePath)).toBe(false);
    expect(git(repo, ["branch", "--list", wt.worktreeBranch])).toContain(wt.worktreeBranch);
    expect(next.current).toEqual({ root: repo, kind: "main" });
    expect(new SessionManager().getSessionWorkspace(sessionId)).toEqual({
      root: repo,
      kind: "main",
    });
    rmSync(lockPath, { force: true });
    execFileSync("git", ["branch", "-D", wt.worktreeBranch], { cwd: repo, env: ENV });
  });

  test("rejects cleanup for a worktree owned by another session", () => {
    const ownerSessionId = "desktopowner";
    const callerSessionId = "desktopcaller";
    const sm = new SessionManager();
    sm.create(repo, "m", "p", ownerSessionId);
    sm.create(repo, "m", "p", callerSessionId);
    const wt = createWorktree(repo, "occupied", ownerSessionId);
    sm.setSessionWorkspace(ownerSessionId, {
      root: wt.worktreePath,
      kind: "worktree",
      worktree: {
        path: wt.worktreePath,
        branch: wt.worktreeBranch,
        baseRef: wt.originalBranch ?? "HEAD",
        createdBy: "codeshell",
      },
    });

    expect(() =>
      cleanupSessionWorktreeForUi(callerSessionId, repo, wt.worktreePath, "discard"),
    ).toThrow(/another session|occupied/i);

    expect(existsSync(wt.worktreePath)).toBe(true);
    expect(git(repo, ["branch", "--list", wt.worktreeBranch])).toContain(wt.worktreeBranch);
  });

  test("rejects unknown-session switch before creating a worktree or branch", () => {
    expect(() => switchSessionWorkspaceForUi("missing-session", repo, "unknownswitch")).toThrow(
      /unknown session/i,
    );

    expect(existsSync(join(repo, "..", ".worktrees", "unknownswitch-missing-"))).toBe(false);
    expect(git(repo, ["branch", "--list", "worktree/unknownswitch-missing-"])).toBe("");
  });

  test("rejects corrupt-session switch before creating a worktree or branch", () => {
    const sessionId = "corruptsession";
    const slug = "corruptswitch";
    mkdirSync(join(home, "sessions", sessionId), { recursive: true });

    expect(() => switchSessionWorkspaceForUi(sessionId, repo, slug)).toThrow(
      /session exists but has no valid state/i,
    );

    expect(existsSync(join(repo, "..", ".worktrees", `${slug}-${sessionId.slice(0, 8)}`))).toBe(
      false,
    );
    expect(git(repo, ["branch", "--list", `worktree/${slug}-${sessionId.slice(0, 8)}`])).toBe("");
  });

  test("rejects unknown-session cleanup before removing a matched worktree", () => {
    const ownerSessionId = "desktopowner";
    const sm = new SessionManager();
    sm.create(repo, "m", "p", ownerSessionId);
    const wt = createWorktree(repo, "unknownclean", ownerSessionId);

    expect(() =>
      cleanupSessionWorktreeForUi("missing-session", repo, wt.worktreePath, "discard"),
    ).toThrow(/unknown session/i);

    expect(existsSync(wt.worktreePath)).toBe(true);
    expect(git(repo, ["branch", "--list", wt.worktreeBranch])).toContain(wt.worktreeBranch);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, SessionManager } from "@cjhyy/code-shell-core";
import {
  cleanupSessionWorktreeForUi,
  getSessionWorktreeDiffForUi,
  getSessionWorkspaceForUi,
  listSessionWorktreesForUi,
  switchSessionWorkspaceForUi,
} from "./session-workspace-service";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf-8" }).trim();
}

describe("cleanupSessionWorktreeForUi", () => {
  let repo: string;
  let root: string;
  let home: string;
  let oldCodeShellHome: string | undefined;
  let oldHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cs-desktop-ws-root-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    home = mkdtempSync(join(tmpdir(), "cs-desktop-ws-home-"));
    oldCodeShellHome = process.env.CODE_SHELL_HOME;
    oldHome = process.env.HOME;
    process.env.CODE_SHELL_HOME = home;
    process.env.HOME = home;
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
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("discard partial branch-delete failure still moves the active session back to main", async () => {
    const sessionId = "desktopbranchfail";
    const sm = new SessionManager();
    sm.create(repo, "m", "p", sessionId);
    const wt = await createWorktree(repo, "desktopfail", sessionId);
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

    const next = await cleanupSessionWorktreeForUi(sessionId, repo, wt.worktreePath, "discard");

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

  test("rejects cleanup for a worktree owned by another session", async () => {
    const ownerSessionId = "desktopowner";
    const callerSessionId = "desktopcaller";
    const sm = new SessionManager();
    sm.create(repo, "m", "p", ownerSessionId);
    sm.create(repo, "m", "p", callerSessionId);
    const wt = await createWorktree(repo, "occupied", ownerSessionId);
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

    await expect(
      cleanupSessionWorktreeForUi(callerSessionId, repo, wt.worktreePath, "discard"),
    ).rejects.toThrow(/another session|occupied/i);

    expect(existsSync(wt.worktreePath)).toBe(true);
    expect(git(repo, ["branch", "--list", wt.worktreeBranch])).toContain(wt.worktreeBranch);
  });

  test("rejects unknown-session switch before creating a worktree or branch", async () => {
    await expect(
      switchSessionWorkspaceForUi("missing-session", repo, "unknownswitch"),
    ).rejects.toThrow(/unknown session/i);

    expect(existsSync(join(repo, "..", ".worktrees", "unknownswitch-missing-"))).toBe(false);
    expect(git(repo, ["branch", "--list", "worktree/unknownswitch-missing-"])).toBe("");
  });

  test("rejects corrupt-session switch before creating a worktree or branch", async () => {
    const sessionId = "corruptsession";
    const slug = "corruptswitch";
    mkdirSync(join(home, "sessions", sessionId), { recursive: true });

    await expect(switchSessionWorkspaceForUi(sessionId, repo, slug)).rejects.toThrow(
      /session exists but has no valid state/i,
    );

    expect(existsSync(join(repo, "..", ".worktrees", `${slug}-${sessionId.slice(0, 8)}`))).toBe(
      false,
    );
    expect(git(repo, ["branch", "--list", `worktree/${slug}-${sessionId.slice(0, 8)}`])).toBe("");
  });

  test("rejects unknown-session cleanup before removing a matched worktree", async () => {
    const ownerSessionId = "desktopowner";
    const sm = new SessionManager();
    sm.create(repo, "m", "p", ownerSessionId);
    const wt = await createWorktree(repo, "unknownclean", ownerSessionId);

    await expect(
      cleanupSessionWorktreeForUi("missing-session", repo, wt.worktreePath, "discard"),
    ).rejects.toThrow(/unknown session/i);

    expect(existsSync(wt.worktreePath)).toBe(true);
    expect(git(repo, ["branch", "--list", wt.worktreeBranch])).toContain(wt.worktreeBranch);
  });

  test("lists worktrees without diff and fetches a single diff separately", async () => {
    const sessionId = "desktopdiff";
    const sm = new SessionManager();
    sm.create(repo, "m", "p", sessionId);
    const wt = await createWorktree(repo, "diff", sessionId);
    writeFileSync(join(wt.worktreePath, "dirty.txt"), "dirty\n");
    sm.setSessionWorkspace(sessionId, {
      root: wt.worktreePath,
      kind: "worktree",
      worktree: {
        path: wt.worktreePath,
        branch: wt.worktreeBranch,
        baseRef: "main",
        createdBy: "codeshell",
      },
    });

    const list = await listSessionWorktreesForUi(sessionId, repo);
    const row = list.worktrees.find((entry) => entry.path === wt.worktreePath);
    expect(row?.isManaged).toBe(true);
    expect(row?.diff).toBeUndefined();

    await expect(getSessionWorktreeDiffForUi(sessionId, wt.worktreePath)).resolves.toMatchObject({
      changedFiles: 1,
      aheadCommits: 0,
      hasUncommittedChanges: true,
    });
  });

  test("rejects cleanup for an external worktree", async () => {
    const sessionId = "desktopexternal";
    const sm = new SessionManager();
    sm.create(repo, "m", "p", sessionId);
    const externalPath = join(repo, "..", ".worktrees", "external-desktop");
    git(repo, ["worktree", "add", "-b", "external/feature", externalPath]);

    const list = await listSessionWorktreesForUi(sessionId, repo);
    const external = list.worktrees.find((entry) => entry.branch === "external/feature");
    expect(external?.isManaged).toBe(false);

    await expect(
      cleanupSessionWorktreeForUi(sessionId, repo, external?.path ?? externalPath, "discard"),
    ).rejects.toThrow(/external worktree/i);
    expect(existsSync(externalPath)).toBe(true);
  });

  test("degrades gracefully when the recorded session cwd is not in a git repo", async () => {
    const sessionId = "nongitsession";
    const nonGit = mkdtempSync(join(tmpdir(), "cs-desktop-ws-non-git-"));
    try {
      const sm = new SessionManager();
      sm.create(nonGit, "m", "p", sessionId);

      const workspace = await getSessionWorkspaceForUi(sessionId, nonGit);
      expect(workspace).toEqual({ root: nonGit, kind: "main" });

      const list = await listSessionWorktreesForUi(sessionId, nonGit);
      expect(list).toMatchObject({
        current: { root: nonGit, kind: "main" },
        mainRoot: nonGit,
        worktrees: [],
      });
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

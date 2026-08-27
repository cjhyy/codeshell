import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@cjhyy/code-shell-core";
import { createWorktree, removeWorktree } from "@cjhyy/code-shell-capability-coding/git";
import { ProjectStore } from "./project-store";
import { SessionCwdIndex } from "./session-cwd-index";
import {
  __setSessionWorkspaceServiceProjectStoreForTests,
  __setSessionWorkspaceServiceSessionManagerForTests,
  cleanupSessionWorktreeForUi,
  getSessionWorkspaceAuthorityForUi,
  getSessionWorktreeDiffForUi,
  getSessionWorkspaceForUi,
  listSessionWorktreesForUi,
  releaseManySessionWorkspacesForUi,
  releaseSessionWorkspaceForUi,
  switchSessionWorkspaceForUi,
} from "./session-workspace-service";
import { readSessionDirectoryForUi, readSessionFileForUi } from "./session-fs-service";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf-8" }).trim();
}

describe("cleanupSessionWorktreeForUi", () => {
  let repo: string;
  let root: string;
  let sessionsDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cs-desktop-ws-root-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    sessionsDir = join(root, "sessions");
    __setSessionWorkspaceServiceSessionManagerForTests(new SessionManager(sessionsDir));
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@t.t"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "f.txt"), "x\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init"]);
    mkdirSync(join(repo, ".code-shell"), { recursive: true });
    writeFileSync(
      join(repo, ".code-shell", "settings.json"),
      JSON.stringify({ worktree: { branchPrefix: "worktree/" } }),
    );
  });

  afterEach(() => {
    __setSessionWorkspaceServiceProjectStoreForTests(undefined);
    __setSessionWorkspaceServiceSessionManagerForTests(undefined);
    rmSync(root, { recursive: true, force: true });
  });

  test("keeps old and new Sessions bound to their authoritative main roots after Make primary", async () => {
    const newPrimary = join(root, "notes");
    mkdirSync(newPrimary);
    const projectStore = await projectStoreForFixture(root, sessionsDir);
    const project = await projectStore.createFromPath(repo);
    const withSecondary = await projectStore.addRoot(project.id, newPrimary);
    const oldMainRoot = withSecondary.project.roots.find(
      (entry) => entry.id === project.primaryRootId,
    )!;
    const newPrimaryRoot = withSecondary.project.roots.find(
      (entry) => entry.id !== oldMainRoot.id,
    )!;
    __setSessionWorkspaceServiceProjectStoreForTests(projectStore);

    const oldSessionId = "old-root-session";
    const newSessionId = "new-root-session";
    const sm = new SessionManager(sessionsDir);
    sm.create(repo, "m", "p", oldSessionId);
    bindSession(sessionsDir, oldSessionId, project.id, oldMainRoot.id);
    await projectStore.setPrimary(project.id, newPrimaryRoot.id);
    sm.create(newPrimary, "m", "p", newSessionId);
    bindSession(sessionsDir, newSessionId, project.id, newPrimaryRoot.id);

    await expect(getSessionWorkspaceAuthorityForUi(oldSessionId)).resolves.toEqual({
      workspace: { root: repo, kind: "main" },
      projectId: project.id,
      mainRootId: oldMainRoot.id,
      mainRoot: oldMainRoot.path,
      mainRootName: oldMainRoot.name,
      rootStatus: "ok",
    });
    await expect(getSessionWorkspaceAuthorityForUi(newSessionId)).resolves.toEqual({
      workspace: { root: newPrimary, kind: "main" },
      projectId: project.id,
      mainRootId: newPrimaryRoot.id,
      mainRoot: newPrimaryRoot.path,
      mainRootName: newPrimaryRoot.name,
      rootStatus: "ok",
    });
  });

  test("authorizes FilesPanel worktree and secondary reads by Session binding and rejects escapes", async () => {
    const secondary = join(root, "secondary");
    mkdirSync(secondary);
    writeFileSync(join(secondary, "secondary.txt"), "secondary\n");
    writeFileSync(join(root, "outside.txt"), "outside\n");
    const projectStore = await projectStoreForFixture(root, sessionsDir);
    const project = await projectStore.createFromPath(repo);
    const withSecondary = await projectStore.addRoot(project.id, secondary);
    const mainRoot = withSecondary.project.roots.find(
      (entry) => entry.id === project.primaryRootId,
    )!;
    const secondaryRoot = withSecondary.project.roots.find((entry) => entry.id !== mainRoot.id)!;
    await projectStore.setPrimary(project.id, secondaryRoot.id);
    __setSessionWorkspaceServiceProjectStoreForTests(projectStore);

    const sessionId = "session-files-worktree";
    const sm = new SessionManager(sessionsDir);
    sm.create(repo, "m", "p", sessionId);
    bindSession(sessionsDir, sessionId, project.id, mainRoot.id);
    const wt = await createWorktree(repo, "files", sessionId);
    writeFileSync(join(wt.worktreePath, "worktree.txt"), "worktree\n");
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

    const mainEntries = await readSessionDirectoryForUi(sessionId, mainRoot.id);
    expect(mainEntries.map((entry) => entry.name)).toContain("worktree.txt");
    const secondaryEntries = await readSessionDirectoryForUi(sessionId, secondaryRoot.id);
    expect(secondaryEntries.map((entry) => entry.name)).toContain("secondary.txt");
    await expect(
      readSessionFileForUi(sessionId, mainRoot.id, join(root, "outside.txt")),
    ).rejects.toThrow(/outside|escape/i);

    const outside = join(root, "not-a-worktree");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    sm.setSessionWorkspace(sessionId, {
      root: outside,
      kind: "worktree",
      worktree: {
        path: outside,
        branch: "forged",
        baseRef: "HEAD",
        createdBy: "codeshell",
      },
    });
    await expect(readSessionDirectoryForUi(sessionId, mainRoot.id)).rejects.toThrow(
      /authorized worktree/i,
    );
    removeWorktree(wt.worktreePath, true);
  });

  test("discard partial branch-delete failure still moves the active session back to main", async () => {
    const sessionId = "desktopbranchfail";
    const sm = new SessionManager(sessionsDir);
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
    expect(new SessionManager(sessionsDir).getSessionWorkspace(sessionId)).toEqual({
      root: repo,
      kind: "main",
    });
    rmSync(lockPath, { force: true });
    execFileSync("git", ["branch", "-D", wt.worktreeBranch], { cwd: repo, env: ENV });
  });

  test("rejects cleanup for a worktree owned by another session", async () => {
    const ownerSessionId = "desktopowner";
    const callerSessionId = "desktopcaller";
    const sm = new SessionManager(sessionsDir);
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
    mkdirSync(join(sessionsDir, sessionId), { recursive: true });

    await expect(switchSessionWorkspaceForUi(sessionId, repo, slug)).rejects.toThrow(
      /session exists but has no valid state/i,
    );

    expect(existsSync(join(repo, "..", ".worktrees", `${slug}-${sessionId.slice(0, 8)}`))).toBe(
      false,
    );
    expect(git(repo, ["branch", "--list", `worktree/${slug}-${sessionId.slice(0, 8)}`])).toBe("");
  });

  test("current and list reject unknown or corrupt sessions", async () => {
    await expect(getSessionWorkspaceForUi("missing-session", repo)).rejects.toThrow(
      /unknown session/i,
    );
    await expect(listSessionWorktreesForUi("missing-session", repo)).rejects.toThrow(
      /unknown session/i,
    );
    mkdirSync(join(sessionsDir, "corruptread"), { recursive: true });
    await expect(getSessionWorkspaceForUi("corruptread", repo)).rejects.toThrow(/valid state/i);
    await expect(listSessionWorktreesForUi("corruptread", repo)).rejects.toThrow(/valid state/i);
  });

  test("workspace reads ignore a renderer-supplied cwd outside the persisted session root", async () => {
    const sessionId = "readroot";
    const outside = mkdtempSync(join(tmpdir(), "cs-desktop-ws-outside-"));
    try {
      const sm = new SessionManager(sessionsDir);
      sm.create(repo, "m", "p", sessionId);
      expect(await getSessionWorkspaceForUi(sessionId, outside)).toEqual({
        root: repo,
        kind: "main",
      });
      expect((await listSessionWorktreesForUi(sessionId, outside)).mainRoot).toBe(repo);
      await expect(getSessionWorktreeDiffForUi(sessionId, outside)).rejects.toThrow(
        /outside the session repository/i,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("rejects unknown-session cleanup before removing a matched worktree", async () => {
    const ownerSessionId = "desktopowner";
    const sm = new SessionManager(sessionsDir);
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
    const sm = new SessionManager(sessionsDir);
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

  test("switch target main returns the session to the main workspace through the UI service path", async () => {
    const sessionId = "desktopmain";
    const sm = new SessionManager(sessionsDir);
    sm.create(repo, "m", "p", sessionId);
    const wt = await createWorktree(repo, "backmain", sessionId);
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

    const list = await switchSessionWorkspaceForUi(sessionId, wt.worktreePath, "main");

    expect(list.current).toEqual({ root: repo, kind: "main" });
    expect(new SessionManager(sessionsDir).getSessionWorkspace(sessionId)).toEqual({
      root: repo,
      kind: "main",
    });
    const transcript = readFileSync(join(sessionsDir, sessionId, "transcript.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const lastMeta = transcript.filter((event) => event.type === "session_meta").at(-1);
    expect(lastMeta.data.workspace).toEqual({ root: repo, kind: "main" });
    expect(lastMeta.data.handoffFrom).toBe(wt.worktreePath);
    removeWorktree(wt.worktreePath, true);
  });

  test("switch routes persistence through a live worker callback before recording handoff", async () => {
    const sessionId = "desktopliveswitch";
    const sm = new SessionManager(sessionsDir);
    sm.create(repo, "m", "p", sessionId);
    const wt = await createWorktree(repo, "live-switch", sessionId);
    const order: string[] = [];

    const list = await switchSessionWorkspaceForUi(sessionId, repo, wt.worktreePath, {
      setLiveWorkspace: async (id, workspace) => {
        order.push("live-rebase");
        expect(id).toBe(sessionId);
        expect(sm.getSessionWorkspace(sessionId)).toEqual({ root: repo, kind: "main" });
        sm.setSessionWorkspace(id, workspace);
      },
    });
    order.push("returned");

    expect(order).toEqual(["live-rebase", "returned"]);
    expect(list.current.root).toBe(wt.worktreePath);
    expect(sm.getSessionWorkspace(sessionId)?.root).toBe(wt.worktreePath);
    removeWorktree(wt.worktreePath, true);
  });

  test("cleanup rebases an active session to main before removing its worktree", async () => {
    const sessionId = "desktoplivecleanup";
    const sm = new SessionManager(sessionsDir);
    sm.create(repo, "m", "p", sessionId);
    const wt = await createWorktree(repo, "live-cleanup", sessionId);
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
    let rebasedBeforeRemoval = false;

    const list = await cleanupSessionWorktreeForUi(sessionId, repo, wt.worktreePath, "discard", {
      setLiveWorkspace: async (id, workspace) => {
        rebasedBeforeRemoval = existsSync(wt.worktreePath);
        sm.setSessionWorkspace(id, workspace);
      },
    });

    expect(rebasedBeforeRemoval).toBe(true);
    expect(existsSync(wt.worktreePath)).toBe(false);
    expect(list.current).toEqual({ root: repo, kind: "main" });
  });

  test("rejects cleanup for an external worktree", async () => {
    const sessionId = "desktopexternal";
    const sm = new SessionManager(sessionsDir);
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
      const sm = new SessionManager(sessionsDir);
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

  test("release removes an archived session from worktree occupancy", async () => {
    const sessionId = "releaseowner";
    const sm = new SessionManager(sessionsDir);
    sm.create(repo, "m", "p", sessionId);
    const wt = await createWorktree(repo, "release", sessionId);
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

    const before = await listSessionWorktreesForUi(sessionId, repo);
    expect(
      before.worktrees.find((entry) => entry.path === wt.worktreePath)?.occupiedBySessionIds,
    ).toContain(sessionId);

    await releaseSessionWorkspaceForUi(sessionId);

    const after = await listSessionWorktreesForUi(sessionId, repo);
    expect(new SessionManager(sessionsDir).getSessionWorkspace(sessionId)).toEqual({
      root: repo,
      kind: "main",
    });
    expect(
      after.worktrees.find((entry) => entry.path === wt.worktreePath)?.occupiedBySessionIds ?? [],
    ).not.toContain(sessionId);
    removeWorktree(wt.worktreePath, true);
  });

  test("release of one owner leaves a shared worktree occupied by the other session", async () => {
    const firstSessionId = "releasefirst";
    const secondSessionId = "releasesecond";
    const sm = new SessionManager(sessionsDir);
    sm.create(repo, "m", "p", firstSessionId);
    sm.create(repo, "m", "p", secondSessionId);
    const wt = await createWorktree(repo, "sharedrelease", firstSessionId);
    const workspace = {
      root: wt.worktreePath,
      kind: "worktree" as const,
      worktree: {
        path: wt.worktreePath,
        branch: wt.worktreeBranch,
        baseRef: wt.originalBranch ?? "HEAD",
        createdBy: "codeshell" as const,
      },
    };
    sm.setSessionWorkspace(firstSessionId, workspace);
    sm.setSessionWorkspace(secondSessionId, workspace);

    await releaseSessionWorkspaceForUi(firstSessionId);

    const after = await listSessionWorktreesForUi(secondSessionId, repo);
    const row = after.worktrees.find((entry) => entry.path === wt.worktreePath);
    expect(new SessionManager(sessionsDir).getSessionWorkspace(firstSessionId)).toEqual({
      root: repo,
      kind: "main",
    });
    expect(row?.occupiedBySessionIds).toContain(secondSessionId);
    expect(row?.occupiedBySessionIds).not.toContain(firstSessionId);
    removeWorktree(wt.worktreePath, true);
  });

  test("releaseMany releases each requested session workspace", async () => {
    const firstSessionId = "releasemany1";
    const secondSessionId = "releasemany2";
    const sm = new SessionManager(sessionsDir);
    sm.create(repo, "m", "p", firstSessionId);
    sm.create(repo, "m", "p", secondSessionId);
    const first = await createWorktree(repo, "manyone", firstSessionId);
    const second = await createWorktree(repo, "manytwo", secondSessionId);
    sm.setSessionWorkspace(firstSessionId, {
      root: first.worktreePath,
      kind: "worktree",
      worktree: {
        path: first.worktreePath,
        branch: first.worktreeBranch,
        baseRef: first.originalBranch ?? "HEAD",
        createdBy: "codeshell",
      },
    });
    sm.setSessionWorkspace(secondSessionId, {
      root: second.worktreePath,
      kind: "worktree",
      worktree: {
        path: second.worktreePath,
        branch: second.worktreeBranch,
        baseRef: second.originalBranch ?? "HEAD",
        createdBy: "codeshell",
      },
    });

    const released = await releaseManySessionWorkspacesForUi([firstSessionId, secondSessionId]);

    expect(released.map((entry) => entry.sessionId).sort()).toEqual(
      [firstSessionId, secondSessionId].sort(),
    );
    expect(new SessionManager(sessionsDir).getSessionWorkspace(firstSessionId)).toEqual({
      root: repo,
      kind: "main",
    });
    expect(new SessionManager(sessionsDir).getSessionWorkspace(secondSessionId)).toEqual({
      root: repo,
      kind: "main",
    });
    removeWorktree(first.worktreePath, true);
    removeWorktree(second.worktreePath, true);
  });

  test("releaseMany returns per-id outcomes for valid and missing sessions", async () => {
    const sessionId = "releasemanymixed";
    const missingSessionId = "releasemanymissing";
    const sm = new SessionManager(sessionsDir);
    sm.create(repo, "m", "p", sessionId);
    const wt = await createWorktree(repo, "manymixed", sessionId);
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

    const released = await releaseManySessionWorkspacesForUi([sessionId, missingSessionId]);

    expect(released.find((entry) => entry.sessionId === sessionId)).toMatchObject({
      ok: true,
      status: "released",
      workspace: { root: repo, kind: "main" },
    });
    expect(released.find((entry) => entry.sessionId === missingSessionId)).toMatchObject({
      ok: true,
      status: "missing",
    });
    expect(new SessionManager(sessionsDir).getSessionWorkspace(sessionId)).toEqual({
      root: repo,
      kind: "main",
    });
    removeWorktree(wt.worktreePath, true);
  });

  test("release of an unknown session is a missing no-op success", async () => {
    const released = await releaseSessionWorkspaceForUi("missing-release-session");

    expect(released).toMatchObject({
      sessionId: "missing-release-session",
      ok: true,
      status: "missing",
    });
  });

  test("release of a corrupt session state is a missing no-op success", async () => {
    const sessionId = "corruptreleasesession";
    mkdirSync(join(sessionsDir, sessionId), { recursive: true });

    const released = await releaseSessionWorkspaceForUi(sessionId);

    expect(released).toMatchObject({
      sessionId,
      ok: true,
      status: "missing",
    });
  });

  test("release awaits live worker reset before persisting the workspace", async () => {
    const sessionId = "releaseorder";
    const sm = new SessionManager(sessionsDir);
    sm.create(repo, "m", "p", sessionId);
    const wt = await createWorktree(repo, "order", sessionId);
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
    const order: string[] = [];

    const released = await releaseSessionWorkspaceForUi(sessionId, {
      releaseLiveWorkspace: async () => {
        order.push("live-reset");
        expect(new SessionManager(sessionsDir).getSessionWorkspace(sessionId)?.root).toBe(
          wt.worktreePath,
        );
      },
    });
    order.push("persisted");

    expect(order).toEqual(["live-reset", "persisted"]);
    expect(released).toMatchObject({
      ok: true,
      status: "released",
      workspace: { root: repo, kind: "main" },
    });
    expect(new SessionManager(sessionsDir).getSessionWorkspace(sessionId)).toEqual({
      root: repo,
      kind: "main",
    });
    removeWorktree(wt.worktreePath, true);
  });

  test("release does not persist when the live worker reset fails", async () => {
    const sessionId = "releasefailreset";
    const sm = new SessionManager(sessionsDir);
    sm.create(repo, "m", "p", sessionId);
    const wt = await createWorktree(repo, "failreset", sessionId);
    const workspace = {
      root: wt.worktreePath,
      kind: "worktree" as const,
      worktree: {
        path: wt.worktreePath,
        branch: wt.worktreeBranch,
        baseRef: wt.originalBranch ?? "HEAD",
        createdBy: "codeshell" as const,
      },
    };
    sm.setSessionWorkspace(sessionId, workspace);

    const released = await releaseSessionWorkspaceForUi(sessionId, {
      releaseLiveWorkspace: async () => {
        throw new Error("worker release timed out");
      },
    });

    expect(released).toMatchObject({
      sessionId,
      ok: false,
      status: "error",
      error: "worker release timed out",
    });
    expect(new SessionManager(sessionsDir).getSessionWorkspace(sessionId)).toEqual(workspace);
    removeWorktree(wt.worktreePath, true);
  });

  test("release is idempotent for a session already on main", async () => {
    const sessionId = "releasemain";
    const sm = new SessionManager(sessionsDir);
    sm.create(repo, "m", "p", sessionId);
    const transcriptPath = join(sessionsDir, sessionId, "transcript.jsonl");
    const before = readFileSync(transcriptPath, "utf-8");

    const released = await releaseSessionWorkspaceForUi(sessionId);

    expect(released).toMatchObject({
      ok: true,
      status: "released",
      workspace: { root: repo, kind: "main" },
    });
    expect(readFileSync(transcriptPath, "utf-8")).toBe(before);
    expect(new SessionManager(sessionsDir).getSessionWorkspace(sessionId)).toEqual({
      root: repo,
      kind: "main",
    });
  });
});

async function projectStoreForFixture(root: string, sessionsDir: string): Promise<ProjectStore> {
  const index = new SessionCwdIndex({ sessionsRoot: sessionsDir });
  await index.ensureLoaded();
  let id = 0;
  return new ProjectStore({
    file: join(root, "desktop", "projects.json"),
    recentsFile: join(root, "desktop", "recents.json"),
    migrationMarkerFile: join(root, "desktop", "migration.json"),
    sessionIndex: index,
    noRepoPath: join(root, "no-repo"),
    randomUUID: () => `session-project-id-${++id}`,
    resolveProjectRoot: (path) => path,
  });
}

function bindSession(
  sessionsDir: string,
  sessionId: string,
  projectId: string,
  mainRootId: string,
): void {
  const statePath = join(sessionsDir, sessionId, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.project = { projectId, mainRootId };
  writeFileSync(statePath, JSON.stringify(state));
}

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type SessionWorkspace } from "@cjhyy/code-shell-core";
import { createWorktree } from "@cjhyy/code-shell-capability-coding/git";
import {
  registerProjectAuthorityIpc,
  type ProjectAuthorityIpcDependencies,
} from "./project-authority-ipc.js";
import { ProjectStore } from "./project-store.js";
import { SessionCwdIndex } from "./session-cwd-index.js";
import {
  __setSessionWorkspaceServiceProjectStoreForTests,
  __setSessionWorkspaceServiceSessionManagerForTests,
  requireSessionFileRootForUi,
} from "./session-workspace-service.js";

interface Reservation {
  cwd: string;
  mainRoot?: string;
  producer: string;
  reservedAt: number;
}

describe("workspace authority for Host-owned process-local sessions", () => {
  let root: string;
  let projectRoot: string;
  let sessionsRoot: string;
  let sessions: SessionManager;
  let handlers: Map<string, (...args: any[]) => unknown>;
  let reservations: Map<string, Reservation>;
  let owners: Map<string, number>;
  let liveWorker: boolean;
  let externalSessions: Set<string>;
  let nativeMutations: string[];
  let lifecycleCalls: Array<{ sessionId: string; callerWebContentsId?: number }>;
  let quiesced: string[];
  let beforeQuiesce: ((sessionId: string) => void) | undefined;
  let quiesceError: Error | undefined;
  let nativeMutationError: Error | undefined;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "cs-host-session-authority-"));
    projectRoot = join(root, "project");
    sessionsRoot = join(root, "sessions");
    mkdirSync(projectRoot);
    sessions = new SessionManager(sessionsRoot);
    const index = new SessionCwdIndex({ sessionsRoot });
    await index.ensureLoaded();
    const projectStore = new ProjectStore({
      file: join(root, "desktop", "projects.json"),
      recentsFile: join(root, "desktop", "recents.json"),
      migrationMarkerFile: join(root, "desktop", "migration.json"),
      sessionIndex: index,
      sessionManager: sessions,
      noRepoPath: join(root, "no-repo"),
      resolveProjectRoot: (path) => path,
    });
    __setSessionWorkspaceServiceSessionManagerForTests(sessions);
    __setSessionWorkspaceServiceProjectStoreForTests(projectStore);
    handlers = new Map();
    reservations = new Map();
    owners = new Map();
    liveWorker = false;
    externalSessions = new Set();
    nativeMutations = [];
    lifecycleCalls = [];
    quiesced = [];
    beforeQuiesce = undefined;
    quiesceError = undefined;
    nativeMutationError = undefined;
    const bridge = {
      hostReservation: (id: string) => reservations.get(id),
      panelOwnerWebContentsId: (id: string) => owners.get(id),
      hasKnownSession: (id: string) => reservations.has(id),
      hasLiveWorker: () => liveWorker,
      setWorkspace: async (id: string, workspace: SessionWorkspace) => {
        nativeMutations.push(`set:${id}`);
        if (nativeMutationError) throw nativeMutationError;
        sessions.setSessionWorkspace(id, workspace);
      },
      releaseWorkspace: async (id: string) => {
        nativeMutations.push(`release:${id}`);
        if (nativeMutationError) throw nativeMutationError;
        sessions.setSessionWorkspace(id, { root: projectRoot, kind: "main" });
      },
    };
    registerProjectAuthorityIpc({
      ipcMain: {
        handle: (channel: string, handler: (...args: any[]) => unknown) =>
          handlers.set(channel, handler),
      },
      projectStore,
      getBridge: () => bridge,
      getExternalRuntimeService: () => ({
        async withWorkspaceMutation<T>(
          sessionId: string,
          operation: (beforePersist?: () => Promise<void>) => Promise<T>,
          callerWebContentsId?: number,
        ): Promise<T> {
          lifecycleCalls.push({ sessionId, callerWebContentsId });
          return operation(
            externalSessions.has(sessionId)
              ? async () => {
                  quiesced.push(sessionId);
                  beforeQuiesce?.(sessionId);
                  if (quiesceError) throw quiesceError;
                }
              : undefined,
          );
        },
      }),
      getAllWindows: () => [],
      getTrust: async () => "trusted",
      assertSessionId: (value: unknown) => {
        if (typeof value !== "string" || !/^[a-zA-Z0-9_-]+$/.test(value))
          throw new Error("invalid session id");
      },
      trackGitRoot: () => {},
      broadcastMobileProjects: async () => {},
    } as unknown as ProjectAuthorityIpcDependencies);
  });

  afterEach(() => {
    __setSessionWorkspaceServiceProjectStoreForTests(undefined);
    __setSessionWorkspaceServiceSessionManagerForTests(undefined);
    rmSync(root, { recursive: true, force: true });
  });

  function reserve(id: string, cwd = projectRoot, mainRoot?: string) {
    reservations.set(id, { cwd, mainRoot, producer: "panel-agent-task", reservedAt: 123 });
    owners.set(id, 71);
  }

  function authority(id: string, sender = 71) {
    return Promise.resolve(handlers.get("workspace:authority")!({ sender: { id: sender } }, id));
  }

  function initializeRepository() {
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: projectRoot,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
        stdio: "pipe",
      });
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.invalid"]);
    git(["config", "user.name", "Test"]);
    git(["commit", "--allow-empty", "-qm", "initial"]);
  }

  async function createWorktreeSession(id: string, external = true) {
    sessions.create(projectRoot, "model", external ? "codex" : "provider", id);
    const worktree = await createWorktree(projectRoot, id, id, { prefix: "worktree/" });
    sessions.setSessionWorkspace(id, {
      root: worktree.worktreePath,
      kind: "worktree",
      worktree: {
        path: worktree.worktreePath,
        branch: worktree.worktreeBranch,
        baseRef: worktree.originalBranch ?? "HEAD",
        createdBy: "codeshell",
      },
    });
    reserve(id, worktree.worktreePath, projectRoot);
    if (external) externalSessions.add(id);
    return worktree;
  }

  test("a reserved live owner's Panel task can resolve authority without creating session files", async () => {
    const id = "panel-task-no-files";
    reserve(id);
    expect(sessions.exists(id)).toBe(false);
    expect(await authority(id)).toMatchObject({
      mainRoot: projectRoot,
      rootStatus: "ok",
      workspace: { root: projectRoot, kind: "main" },
    });
    expect(sessions.exists(id)).toBe(false);
    expect(existsSync(join(sessionsRoot, id))).toBe(false);
  });

  test("a prefix, an owner alone, or a reservation without the live matching owner grants nothing", async () => {
    const id = "panel-task-forged";
    await expect(authority(id)).rejects.toThrow(/unknown session/);
    owners.set(id, 71);
    await expect(authority(id)).rejects.toThrow(/unknown session/);
    reserve(id);
    await expect(authority(id, 72)).rejects.toThrow(/unknown session/);
    owners.delete(id);
    await expect(authority(id)).rejects.toThrow(/unknown session/);
    expect(sessions.exists(id)).toBe(false);
  });

  test("rebind transfers authority to the current window and close revokes the reservation", async () => {
    const id = "panel-task-rebind";
    reserve(id);
    await expect(authority(id)).resolves.toMatchObject({ mainRoot: projectRoot });
    owners.set(id, 72);
    await expect(authority(id)).rejects.toThrow(/unknown session/);
    await expect(authority(id, 72)).resolves.toMatchObject({
      workspace: { root: projectRoot },
    });
    reservations.delete(id);
    owners.delete(id);
    await expect(authority(id, 72)).rejects.toThrow(/unknown session/);
  });

  test("revocation or re-reservation while root validation awaits cannot return stale authority", async () => {
    const id = "panel-task-revoked-during-read";
    for (const revoke of [
      () => owners.set(id, 72),
      () => reservations.delete(id),
      () => reservations.set(id, { ...reservations.get(id)!, reservedAt: 124 }),
    ]) {
      reserve(id);
      const pending = authority(id);
      revoke();
      await expect(pending).rejects.toThrow(/unknown session/);
    }
  });

  test("a worktree task retains its Panel binding root and actual working directory", async () => {
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: projectRoot,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
        stdio: "pipe",
      });
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.invalid"]);
    git(["config", "user.name", "Test"]);
    git(["commit", "--allow-empty", "-qm", "initial"]);
    const worktree = join(root, "worktree");
    git(["worktree", "add", "-q", "-b", "review-worktree", worktree]);
    const id = "panel-task-worktree";
    reserve(id, worktree, projectRoot);
    expect(await authority(id)).toMatchObject({
      mainRoot: projectRoot,
      workspace: { root: worktree, kind: "worktree" },
      rootStatus: "ok",
    });
    expect(sessions.exists(id)).toBe(false);
  });

  test("persisted session authority wins over a different Host reservation", async () => {
    const id = "durable-session";
    sessions.create(projectRoot, "model", "provider", id);
    const otherRoot = join(root, "other-project");
    mkdirSync(otherRoot);
    reserve(id, otherRoot, otherRoot);
    expect(await authority(id)).toMatchObject({
      mainRoot: projectRoot,
      workspace: { root: projectRoot, kind: "main" },
    });
  });

  test("a corrupt or missing persisted root cannot fall back to a healthy reservation", async () => {
    const corruptId = "panel-task-corrupt-state";
    mkdirSync(join(sessionsRoot, corruptId), { recursive: true });
    writeFileSync(join(sessionsRoot, corruptId, "state.json"), "{");
    reserve(corruptId);
    await expect(authority(corruptId)).rejects.toThrow(/valid state/);

    const missingId = "panel-task-missing-root";
    sessions.create(join(root, "missing-directory"), "model", "provider", missingId);
    reserve(missingId);
    expect(await authority(missingId)).toMatchObject({ rootStatus: "dir_missing" });
  });

  test("temporary authority does not enable persisted workspace changes or session file access", async () => {
    const id = "panel-task-readonly-authority";
    const event = { sender: { id: 71 } };
    reserve(id);
    await expect(authority(id)).resolves.toMatchObject({ rootStatus: "ok" });
    await expect(handlers.get("workspace:current")!(event, id, projectRoot)).rejects.toThrow(
      /unknown session/,
    );
    await expect(handlers.get("workspace:switch")!(event, id, projectRoot, "main")).rejects.toThrow(
      /unknown session/,
    );
    await expect(requireSessionFileRootForUi(id, `legacy:${id}`)).rejects.toThrow(
      /unknown session/,
    );
    expect(existsSync(join(sessionsRoot, id))).toBe(false);
  });

  test("switches a known external session to main without borrowing the live native worker", async () => {
    initializeRepository();
    liveWorker = true;
    const id = "external-switch";
    const worktree = await createWorktreeSession(id);
    beforeQuiesce = (sessionId) => {
      expect(sessionId).toBe(id);
      expect(sessions.getSessionWorkspace(id)?.root).toBe(worktree.worktreePath);
    };

    const result = await handlers.get("workspace:switch")!(
      { sender: { id: 71 } },
      id,
      worktree.worktreePath,
      "main",
    );

    expect(result).toMatchObject({ current: { root: projectRoot, kind: "main" } });
    expect(sessions.getSessionWorkspace(id)).toEqual({ root: projectRoot, kind: "main" });
    expect(nativeMutations).toEqual([]);
    expect(quiesced).toEqual([id]);
    expect(lifecycleCalls).toEqual([{ sessionId: id, callerWebContentsId: 71 }]);
  });

  test("quiesces the external owner before deleting its current managed worktree", async () => {
    initializeRepository();
    liveWorker = true;
    const id = "external-cleanup";
    const worktree = await createWorktreeSession(id);
    beforeQuiesce = () => {
      expect(existsSync(worktree.worktreePath)).toBe(true);
      expect(sessions.getSessionWorkspace(id)?.root).toBe(worktree.worktreePath);
    };

    const result = await handlers.get("workspace:cleanup")!(
      { sender: { id: 71 } },
      id,
      worktree.worktreePath,
      worktree.worktreePath,
      "detach",
    );

    expect(result).toMatchObject({ current: { root: projectRoot, kind: "main" } });
    expect(existsSync(worktree.worktreePath)).toBe(false);
    expect(sessions.getSessionWorkspace(id)).toEqual({ root: projectRoot, kind: "main" });
    expect(nativeMutations).toEqual([]);
    expect(quiesced).toEqual([id]);
    expect(lifecycleCalls).toEqual([{ sessionId: id, callerWebContentsId: 71 }]);
  });

  test("release quiesces an external session and persists main without calling the native worker", async () => {
    initializeRepository();
    liveWorker = true;
    const id = "external-release";
    const worktree = await createWorktreeSession(id);
    beforeQuiesce = () => {
      expect(sessions.getSessionWorkspace(id)?.root).toBe(worktree.worktreePath);
    };

    const result = await handlers.get("workspace:release")!({ sender: { id: 71 } }, id);

    expect(result).toMatchObject({ sessionId: id, ok: true, status: "released" });
    expect(sessions.getSessionWorkspace(id)).toEqual({ root: projectRoot, kind: "main" });
    expect(existsSync(worktree.worktreePath)).toBe(true);
    expect(nativeMutations).toEqual([]);
    expect(quiesced).toEqual([id]);
    expect(lifecycleCalls).toEqual([{ sessionId: id, callerWebContentsId: 71 }]);
  });

  test("releaseMany selects the owning runtime separately for external and native sessions", async () => {
    initializeRepository();
    liveWorker = true;
    const externalId = "external-release-many";
    const nativeId = "native-release-many";
    await createWorktreeSession(externalId);
    await createWorktreeSession(nativeId, false);

    const result = await handlers.get("workspace:releaseMany")!({ sender: { id: 71 } }, [
      externalId,
      nativeId,
      externalId,
    ]);

    expect(result).toEqual([
      expect.objectContaining({ sessionId: externalId, ok: true, status: "released" }),
      expect.objectContaining({ sessionId: nativeId, ok: true, status: "released" }),
    ]);
    expect(sessions.getSessionWorkspace(externalId)).toEqual({ root: projectRoot, kind: "main" });
    expect(sessions.getSessionWorkspace(nativeId)).toEqual({ root: projectRoot, kind: "main" });
    expect(nativeMutations).toEqual([`release:${nativeId}`]);
    expect(quiesced).toEqual([externalId]);
    expect(lifecycleCalls).toEqual([
      { sessionId: externalId, callerWebContentsId: 71 },
      { sessionId: nativeId, callerWebContentsId: 71 },
    ]);
  });

  test("a native worker persistence failure cannot fall back to a host workspace write", async () => {
    initializeRepository();
    liveWorker = true;
    const id = "native-switch-failed";
    const worktree = await createWorktreeSession(id, false);
    nativeMutationError = new Error("native workspace persistence failed");

    await expect(
      handlers.get("workspace:switch")!({ sender: { id: 71 } }, id, worktree.worktreePath, "main"),
    ).rejects.toThrow("native workspace persistence failed");

    expect(sessions.getSessionWorkspace(id)?.root).toBe(worktree.worktreePath);
    expect(nativeMutations).toEqual([`set:${id}`]);
    expect(quiesced).toEqual([]);
  });

  for (const action of ["switch", "cleanup", "release"] as const) {
    test(`a rejected external quiesce leaves the ${action} workspace and directory intact`, async () => {
      initializeRepository();
      liveWorker = true;
      const id = `external-${action}-blocked`;
      const worktree = await createWorktreeSession(id);
      const previous = sessions.getSessionWorkspace(id);
      quiesceError = new Error("external session still has active work");
      const event = { sender: { id: 71 } };

      if (action === "release") {
        await expect(handlers.get("workspace:release")!(event, id)).resolves.toMatchObject({
          sessionId: id,
          ok: false,
          status: "error",
        });
      } else {
        const operation =
          action === "switch"
            ? handlers.get("workspace:switch")!(event, id, worktree.worktreePath, "main")
            : handlers.get("workspace:cleanup")!(
                event,
                id,
                worktree.worktreePath,
                worktree.worktreePath,
                "discard",
              );
        await expect(operation).rejects.toThrow("external session still has active work");
      }

      expect(sessions.getSessionWorkspace(id)).toEqual(previous);
      expect(existsSync(worktree.worktreePath)).toBe(true);
      expect(nativeMutations).toEqual([]);
      expect(quiesced).toEqual([id]);
    });
  }
});

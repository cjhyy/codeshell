import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@cjhyy/code-shell-core";
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
    const bridge = {
      hostReservation: (id: string) => reservations.get(id),
      panelOwnerWebContentsId: (id: string) => owners.get(id),
      hasKnownSession: (id: string) => reservations.has(id),
      hasLiveWorker: () => false,
    };
    registerProjectAuthorityIpc({
      ipcMain: {
        handle: (channel: string, handler: (...args: any[]) => unknown) =>
          handlers.set(channel, handler),
      },
      projectStore,
      getBridge: () => bridge,
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
});

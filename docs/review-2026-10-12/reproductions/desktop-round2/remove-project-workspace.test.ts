import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SessionManager } from "@cjhyy/code-shell-core";
import { ProjectStore } from "../../../../packages/desktop/src/main/project-store";
import { SessionCwdIndex } from "../../../../packages/desktop/src/main/session-cwd-index";
import {
  __setSessionWorkspaceServiceProjectStoreForTests,
  __setSessionWorkspaceServiceSessionManagerForTests,
  switchSessionWorkspaceForUi,
  releaseManySessionWorkspacesForUi,
  listSessionWorktreesForUi,
  cleanupSessionWorktreeForUi,
} from "../../../../packages/desktop/src/main/session-workspace-service";
import { ensureMiniDom } from "../../../../packages/desktop/src/renderer/test-utils/renderHook";
import { useSessionNavigation } from "../../../../packages/desktop/src/renderer/app/useSessionNavigation";
import {
  saveSessionIndex,
  loadSessionIndex,
} from "../../../../packages/desktop/src/renderer/transcripts";
import { trackedProjectFromRegistry } from "../../../../packages/desktop/src/renderer/projects";
let root = "";
afterEach(() => {
  __setSessionWorkspaceServiceProjectStoreForTests(undefined);
  __setSessionWorkspaceServiceSessionManagerForTests(undefined);
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

test("CONFIRMED removing a project tombstones it before archived worktree sessions can detach", async () => {
  ensureMiniDom();
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
  });
  root = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-review-remove-project-")));
  const repo = join(root, "project");
  mkdirSync(repo);
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      stdio: "pipe",
      encoding: "utf8",
    }).trim();
  git(["init", "-q"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(repo, "file.txt"), "fixture\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "fixture"]);
  const sessionsRoot = join(root, "sessions"),
    sm = new SessionManager(sessionsRoot),
    index = new SessionCwdIndex({ sessionsRoot });
  await index.ensureLoaded();
  const store = new ProjectStore({
    file: join(root, "projects.json"),
    recentsFile: join(root, "recents.json"),
    migrationMarkerFile: join(root, "migration.json"),
    sessionIndex: index,
    sessionManager: sm,
    noRepoPath: join(root, "no-repo"),
  });
  const project = await store.createFromPath(repo),
    sid = "idle-disk-session";
  sm.create(repo, "fixture-model", "fixture-provider", sid);
  sm.updateSessionState(sid, {
    project: { projectId: project.id, mainRootId: project.primaryRootId },
  });
  __setSessionWorkspaceServiceProjectStoreForTests(store);
  __setSessionWorkspaceServiceSessionManagerForTests(sm);
  const attached = await switchSessionWorkspaceForUi(sid, repo, "fixture-work");
  expect(attached.current.kind).toBe("worktree");
  const worktree = attached.current.root;
  const summary = { id: sid, engineSessionId: sid, title: "Idle task", createdAt: 1, updatedAt: 1 };
  saveSessionIndex(project.id, { sessions: [summary], activeSessionId: sid });
  const releaseResults: any[] = [];
  const calls: string[] = [];
  let removing: Promise<void> | undefined;
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    value: {
      log() {},
      projectRegistry: {
        remove: (id: string) => {
          calls.push("remove");
          removing = store.remove(id);
          return removing;
        },
      },
      releaseManySessionWorkspaces: async (ids: string[]) => {
        calls.push("release");
        const result = await releaseManySessionWorkspacesForUi(ids);
        releaseResults.push(...result);
        return result;
      },
      setSessionArchived: async (id: string, archived: boolean) => {
        calls.push("archive");
        sm.setSessionArchived(id, archived ? Date.now() : undefined);
      },
    },
  });
  const navigation = useSessionNavigation({
    projects: [trackedProjectFromRegistry(project)],
    setProjects: () => {},
    activeProjectId: project.id,
    setActiveProjectId: () => {},
    sessionIndices: { [project.id]: loadSessionIndex(project.id) },
    setSessionIndices: () => {},
    setCollapsedProjects: () => {},
    setUnreadBuckets: () => {},
    setPermissionOverrides: () => {},
    setModelOverrides: () => {},
    setGoalOverrides: () => {},
    panelByBucket: {},
    setPanelByBucket: () => {},
    activeBucketRef: { current: "" },
    setView: () => {},
    setRunsInitialRunId: () => {},
  });
  await navigation.handleRemoveProject(project.id);
  await removing;
  expect(calls).toEqual(["remove", "release", "archive"]);
  expect(releaseResults[0]).toMatchObject({ sessionId: sid, ok: false, status: "error" });
  expect(releaseResults[0].error).toContain("root_removed");
  expect(sm.getSessionWorkspace(sid)?.root).toBe(worktree);
  expect(sm.readSessionArchivedAt(sid)).toBeNumber();
  expect(loadSessionIndex(project.id).sessions[0]?.archived).toBe(true);
  // Re-adding the folder is the ordinary recovery path. The archived task
  // still owns the worktree, because the intended detach never ran.
  const restored = await store.createFromPath(repo);
  expect(restored.id).toBe(project.id);
  sm.create(repo, "fixture-model", "fixture-provider", "new-session");
  sm.updateSessionState("new-session", {
    project: { projectId: project.id, mainRootId: project.primaryRootId },
  });
  const visible = await listSessionWorktreesForUi("new-session", repo);
  expect(
    visible.worktrees.find((entry) => entry.path === worktree)?.occupiedBySessionIds,
  ).toContain(sid);
  await expect(
    cleanupSessionWorktreeForUi("new-session", repo, worktree, "detach"),
  ).rejects.toThrow("worktree is occupied by another session");
  console.log(
    JSON.stringify({
      calls,
      releaseResult: releaseResults[0],
      archived: true,
      retainedWorkspace: sm.getSessionWorkspace(sid),
      occupiedBy: visible.worktrees.find((entry) => entry.path === worktree)?.occupiedBySessionIds,
    }),
  );
});

import { fileURLToPath } from "node:url";
const PRODUCT_REVIEW_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
const repo = PRODUCT_REVIEW_ROOT;
const isolation = await import(repo + "/scripts/runtime-cost-smoke-isolation.mjs");
isolation.installLocalNetworkGuard("http://127.0.0.1:9");
const { default: ts } = await import(repo + "/node_modules/typescript/lib/typescript.js");
const { SessionManager } = await import(repo + "/packages/core/src/index.ts");
const { releaseOwnedSessionWorkspace } = await import(repo + "/packages/core/src/engine/engine-workspace-authority.ts");
const { ProjectStore } = await import(repo + "/packages/desktop/src/main/project-store.ts");
const { SessionCwdIndex } = await import(repo + "/packages/desktop/src/main/session-cwd-index.ts");
const { __setSessionWorkspaceServiceProjectStoreForTests, __setSessionWorkspaceServiceSessionManagerForTests, switchSessionWorkspaceForUi, releaseSessionWorkspaceForUi, releaseManySessionWorkspacesForUi, listSessionWorktreesForUi, cleanupSessionWorktreeForUi } = await import(repo + "/packages/desktop/src/main/session-workspace-service.ts");
const { ensureMiniDom } = await import(repo + "/packages/desktop/src/renderer/test-utils/renderHook.tsx");
const { useSessionNavigation } = await import(repo + "/packages/desktop/src/renderer/app/useSessionNavigation.ts");
const { saveSessionIndex, loadSessionIndex, loadDeletedArchivedIndices, archiveSession } = await import(repo + "/packages/desktop/src/renderer/transcripts.ts");
const { trackedProjectFromRegistry } = await import(repo + "/packages/desktop/src/renderer/projects.ts");
let root = "";
afterEach(() => {
  __setSessionWorkspaceServiceProjectStoreForTests(undefined);
  __setSessionWorkspaceServiceSessionManagerForTests(undefined);
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

test("CONFIRMED cold release fails after tombstone; resident helper already detaches; re-add and owner recovery permit safe cleanup", async () => {
  ensureMiniDom();
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() { return values.size; },
      key: (index) => [...values.keys()][index] ?? null,
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
  const residentId = "resident-session";
  sm.create(repo, "fixture-model", "fixture-provider", residentId);
  sm.updateSessionState(residentId, { project: { projectId: project.id, mainRootId: project.primaryRootId } });
  const residentAttached = await switchSessionWorkspaceForUi(residentId, repo, "resident-work");
  const residentWorktree = residentAttached.current.root;

  const summary = { id: sid, engineSessionId: sid, title: "Idle task", createdAt: 1, updatedAt: 1 };
  saveSessionIndex(project.id, { sessions: [summary, { ...summary, id: residentId, engineSessionId: residentId }], activeSessionId: sid });
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
        const result = await releaseManySessionWorkspacesForUi(ids, {
          // This is the actual Core helper behind the resident Engine RPC, not a fabricated write.
          // No real worker or Engine run is started in this boundary fixture.
          releaseLiveWorkspace: async (id) => {
            if (id === residentId) releaseOwnedSessionWorkspace({ sessionManager: sm, sessionId: id });
          },
        });
        releaseResults.push(...result);
        return result;
      },
      releaseSessionWorkspace: async (id: string) => releaseSessionWorkspaceForUi(id),
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
  expect(calls).toEqual(["remove", "release", "archive", "archive"]);
  expect(sm.getSessionWorkspace(residentId)).toEqual({ root: repo, kind: "main" });
  expect(existsSync(residentWorktree)).toBe(true);
  expect(releaseResults[1]).toMatchObject({ sessionId: residentId, ok: false, status: "error" });
  expect(loadDeletedArchivedIndices(new Set())[project.id]?.sessions).toHaveLength(2);
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
  expect(existsSync(worktree)).toBe(true);
  const beforeRecovery = {
    coldWorkspace: sm.getSessionWorkspace(sid),
    residentWorkspace: sm.getSessionWorkspace(residentId),
    occupiedBy: visible.worktrees.find((entry) => entry.path === worktree)?.occupiedBySessionIds,
    archived: loadSessionIndex(project.id).sessions.find((s) => s.id === sid)?.archived,
  };
  // Re-adding alone intentionally does not detach an archived owner. Restore and re-archive
  // that owner through the existing renderer action, now with live project authority.
  const appFile = readFileSync(join(PRODUCT_REVIEW_ROOT, "packages/desktop/src/renderer/App.tsx"), "utf8");
  const ast = ts.createSourceFile("App.tsx", appFile, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let restoreArrow: any;
  const visit = (node: any) => {
    if (!restoreArrow && ts.isJsxAttribute(node) && node.name.getText(ast) === "onRestoreArchivedSession") restoreArrow = node.initializer.expression;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const restoreJs = ts.transpileModule("const restore = " + restoreArrow.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const restore = runInNewContext(restoreJs + "\nrestore", { archiveSession, setSessionIndices: () => {}, projectBucketSegmentFor: (id: string) => id });
  restore(project.id, sid); // actual Settings callback: restore catalog visibility; no workspace release
  expect(loadSessionIndex(project.id).sessions.find((s) => s.id === sid)?.archived).toBe(false);
  expect(sm.getSessionWorkspace(sid)?.root).toBe(worktree);
  await navigation.handleArchiveSession(project.id, sid, true);
  expect(sm.getSessionWorkspace(sid)).toEqual({ root: repo, kind: "main" });
  expect(existsSync(worktree)).toBe(true); // release preserves checkout and files
  const afterRecovery = await listSessionWorktreesForUi("new-session", repo);
  expect(afterRecovery.worktrees.find((entry) => entry.path === worktree)?.occupiedBySessionIds ?? []).not.toContain(sid);
  await cleanupSessionWorktreeForUi("new-session", repo, worktree, "detach");
  expect(existsSync(worktree)).toBe(false);
  console.log(
    JSON.stringify({
      calls,
      releaseResults,
      beforeRecovery,
      afterRecovery: {
        coldWorkspace: sm.getSessionWorkspace(sid),
        occupiedBy: afterRecovery.worktrees.find((entry) => entry.path === worktree)?.occupiedBySessionIds ?? [],
        cleaned: !existsSync(worktree),
      },
    }),
  );
});

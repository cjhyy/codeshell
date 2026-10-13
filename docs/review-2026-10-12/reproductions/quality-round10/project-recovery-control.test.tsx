import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
const forbidden = (..._args: any[]) => { throw new Error("NETWORK_FORBIDDEN_round10"); };
globalThis.fetch = forbidden as any;
http.request = http.get = forbidden as any;
https.request = https.get = forbidden as any;
net.connect = net.createConnection = forbidden as any;
tls.connect = forbidden as any;
if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-")) {
  throw new Error("guarded HOME required");
}
import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const {
  ensureMiniDom,
  flushMicrotasks,
  renderHook,
} = await import("../../../../packages/desktop/src/renderer/test-utils/renderHook");
const { useTrackedProjects } = await import("../../../../packages/desktop/src/renderer/app/useTrackedProjects");
const { useProjectRegistrySync } = await import("../../../../packages/desktop/src/renderer/app/useProjectRegistrySync");
const { useSessionNavigation } = await import("../../../../packages/desktop/src/renderer/app/useSessionNavigation");
const { __resetProjectSnapshotForTest } = await import("../../../../packages/desktop/src/renderer/projects");
const {
  getSessionPersistence,
  initializeSessionPersistence,
} = await import("../../../../packages/desktop/src/renderer/sessionPersistence");
const { ProjectStore } = await import("../../../../packages/desktop/src/main/project-store");
const { SessionCwdIndex } = await import("../../../../packages/desktop/src/main/session-cwd-index");
const { SessionCatalogStore } = await import("../../../../packages/desktop/src/main/session-catalog-store");
const { createLegacyProjectMigrationService } = await import("../../../../packages/desktop/src/main/legacy-project-migration");
let fixtureRoot = "";
let hook: any;
afterEach(async () => {
  await hook?.unmount();
  hook = undefined;
  getSessionPersistence()?.dispose();
  __resetProjectSnapshotForTest();
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = "";
});
test("CONTROL newer registry event restores project lost from the startup projection", async () => {
  ensureMiniDom();
  __resetProjectSnapshotForTest();
  fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-review-startup-snapshot-")));
  const primary = join(fixtureRoot, "first-project"),
    added = join(fixtureRoot, "added-project");
  mkdirSync(primary);
  mkdirSync(added);
  const sessionIndex = new SessionCwdIndex({ sessionsRoot: join(fixtureRoot, "sessions") });
  await sessionIndex.ensureLoaded();
  const projectStore = new ProjectStore({
    file: join(fixtureRoot, "projects.json"),
    recentsFile: join(fixtureRoot, "recents.json"),
    migrationMarkerFile: join(fixtureRoot, "migration.json"),
    sessionIndex,
    noRepoPath: join(fixtureRoot, "no-repo"),
  });
  const original = await projectStore.createFromPath(primary);
  await projectStore.completeLegacyMigration();
  const migration = createLegacyProjectMigrationService({
    store: projectStore,
    pickDirectory: async () => null,
  });
  const catalog = new SessionCatalogStore({ file: join(fixtureRoot, "session-catalog.json") });
  const indices = {
    "legacy-project-id": {
      sessions: [{ id: "legacy-session", title: "Old conversation", createdAt: 1, updatedAt: 1 }],
      activeSessionId: "legacy-session",
    },
  };
  await catalog.importLegacy(indices);
  const storage = new Map<string, string>([
    [
      "codeshell.repos",
      JSON.stringify([{ id: "legacy-project-id", name: "First", path: primary, addedAt: 1 }]),
    ],
  ]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
      key: (index) => Array.from(storage.keys())[index] ?? null,
      get length() {
        return storage.size;
      },
    },
  });
  let renameRequest: Promise<any> | undefined;
  let resolveCopy: any;
  let copyStarted = false;
  const copying = new Promise<void>((resolve) => (resolveCopy = resolve));
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    value: {
      log() {},
      projectRegistry: {
        list: () => projectStore.list(),
        onChanged: (listener) => projectStore.onChanged(listener),
        beginLegacyMigration: (paths) => migration.begin(paths),
        authorizeLegacyMigration: (token, path) => migration.authorizePath(token, path),
        completeLegacyMigration: (token) => migration.complete(token),
        createFromPicker: () => projectStore.createFromPath(added),
        rename: (id, name) => (renameRequest = projectStore.rename(id, name)),
      },
      sessionCatalog: {
        load: () => catalog.load(),
        importLegacy: (indices) => catalog.importLegacy(indices),
        apply: (patch) => catalog.apply(patch),
        onChanged: (listener) => catalog.onChanged(listener),
        readTranscript: async () => ({ value: '{"messages":[]}', hasEarlier: false }),
        writeTranscript: async () => {
          copyStarted = true;
          await copying;
        },
        deleteTranscript: async () => {},
      },
    },
  });
  await initializeSessionPersistence();
  hook = await renderHook(() => {
    const [projects, setProjects] = useTrackedProjects();
    const [sessionIndices, setSessionIndices] = React.useState<any>({});
    const [activeProjectId, setActiveProjectId] = React.useState<string | null>(null);
    useProjectRegistrySync({
      setProjects,
      setSessionIndices,
      setActiveProjectId,
      setPermissionOverrides: () => {},
      setModelOverrides: () => {},
      setGoalOverrides: () => {},
    });
    const navigation = useSessionNavigation({
      projects,
      setProjects,
      activeProjectId,
      setActiveProjectId,
      sessionIndices,
      setSessionIndices,
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
    return { projects, activeProjectId, ...navigation };
  });
  expect(copyStarted).toBe(true);
  await act(async () => {
    await hook.result.current.handleAddProject();
    await flushMicrotasks();
  });
  const addedProject = (await projectStore.list()).find((project) => project.id !== original.id)!;
  expect(hook.result.current.projects.map((project) => project.id)).toContain(addedProject.id);
  expect(hook.result.current.activeProjectId).toBe(addedProject.id);
  await act(async () => {
    resolveCopy();
    await getSessionPersistence()!.flush();
    await flushMicrotasks();
  });
  // Main durably retains both projects, while the delayed initialization
  // removes the newly selected project's renderer authority and sidebar row.
  expect(await projectStore.list()).toHaveLength(2);
  expect(hook.result.current.projects.map((project) => project.id)).toEqual([original.id]);
  expect(hook.result.current.activeProjectId).toBe(addedProject.id);
  await act(async () => { hook.result.current.handleRenameProject(original.id, "Visible first renamed"); await renameRequest; await flushMicrotasks(); });
  expect(hook.result.current.projects.map((project) => project.id)).toEqual([original.id, addedProject.id]);
  expect(hook.result.current.activeProjectId).toBe(addedProject.id);
  expect(hook.result.current.projects.find((p) => p.id === original.id).name).toBe("Visible first renamed");
  console.log(
    JSON.stringify({
      mainProjectIds: (await projectStore.list()).map((project) => project.id),
      rendererProjectIds: hook.result.current.projects.map((project) => project.id),
      activeProjectId: hook.result.current.activeProjectId,
    }),
  );
});

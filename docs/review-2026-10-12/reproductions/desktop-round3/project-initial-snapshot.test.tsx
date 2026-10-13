import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureMiniDom,
  flushMicrotasks,
  renderHook,
} from "../../../../packages/desktop/src/renderer/test-utils/renderHook";
import { useTrackedProjects } from "../../../../packages/desktop/src/renderer/app/useTrackedProjects";
import { useProjectRegistrySync } from "../../../../packages/desktop/src/renderer/app/useProjectRegistrySync";
import { useSessionNavigation } from "../../../../packages/desktop/src/renderer/app/useSessionNavigation";
import { __resetProjectSnapshotForTest } from "../../../../packages/desktop/src/renderer/projects";
import {
  getSessionPersistence,
  initializeSessionPersistence,
} from "../../../../packages/desktop/src/renderer/sessionPersistence";
import { ProjectStore } from "../../../../packages/desktop/src/main/project-store";
import { SessionCwdIndex } from "../../../../packages/desktop/src/main/session-cwd-index";
import { SessionCatalogStore } from "../../../../packages/desktop/src/main/session-catalog-store";
import { createLegacyProjectMigrationService } from "../../../../packages/desktop/src/main/legacy-project-migration";
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
test("CONFIRMED finishing startup bucket migration overwrites a project added after the initial snapshot", async () => {
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
  console.log(
    JSON.stringify({
      mainProjectIds: (await projectStore.list()).map((project) => project.id),
      rendererProjectIds: hook.result.current.projects.map((project) => project.id),
      activeProjectId: hook.result.current.activeProjectId,
    }),
  );
});

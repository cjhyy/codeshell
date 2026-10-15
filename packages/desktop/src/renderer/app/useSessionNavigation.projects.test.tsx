import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useRef, useState } from "react";
import type { LocalProject } from "../../preload/project-authority-types";
import {
  loadProjects,
  projectIdForPath,
  saveProjects,
  trackedProjectFromRegistry,
  type TrackedProject,
} from "../projects";
import {
  bucketKey,
  loadSessionIndex,
  upsertImportedSession,
  type SessionIndex,
} from "../transcripts";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import { useTrackedProjects } from "./useTrackedProjects";
import { useProjectRegistrySync } from "./useProjectRegistrySync";
import { useSessionNavigation } from "./useSessionNavigation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const project: LocalProject = {
  id: "travel-project",
  name: "旅游",
  roots: [{ id: "travel-root", path: "/workspace/travel", name: "旅游", addedAt: 1 }],
  primaryRootId: "travel-root",
  createdAt: 1,
  updatedAt: 1,
  lastOpenedAt: 1,
  revision: 1,
};

const activeIndex: SessionIndex = {
  sessions: [{ id: "travel-session", title: "行程规划", createdAt: 1, updatedAt: 2 }],
  activeSessionId: "travel-session",
};

describe("project picker and registry synchronization", () => {
  let savedStorage: PropertyDescriptor | undefined;
  let savedBridge: PropertyDescriptor | undefined;
  let savedProjects: TrackedProject[];
  let diskProjects: LocalProject[];
  let initialIndices: Record<string, SessionIndex>;
  let pendingPicks: Array<ReturnType<typeof deferred<LocalProject | null>>>;
  let listeners: Set<(projects: LocalProject[]) => void>;
  let beforeSelectLocalSession: ((projectId: string | null) => Promise<boolean>) | undefined;
  let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useHarness>>>> | undefined;

  function useHarness() {
    const [projects, setProjects] = useTrackedProjects();
    const [sessionIndices, setSessionIndices] = useState(initialIndices);
    const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
    const activeBucketRef = useRef("");
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
      activeBucketRef,
      setView: () => {},
      setRunsInitialRunId: () => {},
      beforeSelectLocalSession,
    });
    const renderedTargets = projects.map((item) => projectIdForPath(item.path));
    return {
      ...navigation,
      projects,
      sessionIndices,
      activeProjectId,
      setSessionIndices,
      renderedTargets,
      activeBucketRef,
    };
  }

  beforeEach(() => {
    ensureMiniDom();
    savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    savedBridge = Object.getOwnPropertyDescriptor(window, "codeshell");
    savedProjects = loadProjects();
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    saveProjects([]);
    diskProjects = [];
    initialIndices = {};
    pendingPicks = [];
    listeners = new Set();
    beforeSelectLocalSession = undefined;
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: {
        log: () => {},
        projectRegistry: {
          list: async () => diskProjects,
          beginLegacyMigration: async () => ({ completed: true }),
          createFromPicker: () => {
            const pending = deferred<LocalProject | null>();
            pendingPicks.push(pending);
            return pending.promise;
          },
          onChanged: (listener: (projects: LocalProject[]) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          resolveForCwdBatch: async (cwds: string[]) =>
            cwds.map(() => ({
              projectId: project.id,
              rootId: project.primaryRootId,
              created: false,
            })),
        },
      },
    });
  });

  afterEach(async () => {
    await hook?.unmount();
    hook = undefined;
    saveProjects(savedProjects);
    if (savedStorage) Object.defineProperty(globalThis, "localStorage", savedStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (savedBridge) Object.defineProperty(window, "codeshell", savedBridge);
    else Reflect.deleteProperty(window, "codeshell");
  });

  async function broadcast(projects: LocalProject[]) {
    await act(async () => {
      diskProjects = projects;
      for (const listener of listeners) listener(projects);
    });
  }

  test("resolves project configuration during the first render after registry hydration", async () => {
    diskProjects = [project];
    hook = await renderHook(useHarness);
    expect(hook.result.current.projects).toHaveLength(1);
    expect(hook.result.current.renderedTargets).toEqual([project.id]);
  });

  test("resolves replaced registry roots in the same render and removes stale paths", async () => {
    diskProjects = [project];
    hook = await renderHook(useHarness);
    const replacement = {
      ...project,
      roots: [{ ...project.roots[0]!, path: "/workspace/moved-travel" }],
    };
    await broadcast([replacement]);
    expect(hook.result.current.renderedTargets).toEqual([project.id]);
    expect(projectIdForPath(project.roots[0]!.path)).toBeUndefined();
    await broadcast([]);
    expect(hook.result.current.projects).toEqual([]);
    expect(projectIdForPath(replacement.roots[0]!.path)).toBeUndefined();
  });

  test("keeps one project when its registry broadcast arrives before the picker response", async () => {
    hook = await renderHook(useHarness);
    const adding = hook.result.current.handleAddProject();

    await broadcast([project]);
    expect(hook.result.current.projects).toHaveLength(1);
    await act(async () => {
      pendingPicks[0]!.resolve(project);
      await adding;
    });

    expect(hook.result.current.projects).toEqual([trackedProjectFromRegistry(project)]);
    expect(hook.result.current.activeProjectId).toBe(project.id);
  });

  test("preserves session state populated while the project picker is pending", async () => {
    hook = await renderHook(useHarness);
    const adding = hook.result.current.handleAddProject();
    await broadcast([project]);
    await act(async () => {
      hook!.result.current.setSessionIndices({ [project.id]: activeIndex });
    });
    await act(async () => {
      pendingPicks[0]!.resolve(project);
      await adding;
    });

    expect(hook.result.current.sessionIndices[project.id]).toBe(activeIndex);
  });

  test("keeps one project when the picker response arrives before its registry broadcast", async () => {
    hook = await renderHook(useHarness);
    const adding = hook.result.current.handleAddProject();
    await act(async () => {
      pendingPicks[0]!.resolve(project);
      await adding;
    });
    expect(hook.result.current.projects).toHaveLength(1);
    await broadcast([project]);

    expect(hook.result.current.projects).toEqual([trackedProjectFromRegistry(project)]);
    expect(hook.result.current.sessionIndices[project.id]).toEqual({
      sessions: [],
      activeSessionId: null,
    });
  });

  test("selects an existing project without replacing its sessions", async () => {
    diskProjects = [project];
    initialIndices = { [project.id]: activeIndex };
    hook = await renderHook(useHarness);
    const adding = hook.result.current.handleAddProject();
    await act(async () => {
      pendingPicks[0]!.resolve(project);
      await adding;
    });

    expect(hook.result.current.projects).toHaveLength(1);
    expect(hook.result.current.activeProjectId).toBe(project.id);
    expect(hook.result.current.sessionIndices[project.id]).toBe(activeIndex);
  });

  test("deduplicates two pending picker requests that return the same project", async () => {
    hook = await renderHook(useHarness);
    const first = hook.result.current.handleAddProject();
    const second = hook.result.current.handleAddProject();
    await act(async () => {
      pendingPicks[1]!.resolve(project);
      await second;
    });
    await act(async () => {
      pendingPicks[0]!.resolve(project);
      await first;
    });

    expect(hook.result.current.projects).toHaveLength(1);
    expect(hook.result.current.activeProjectId).toBe(project.id);
  });

  test("leaves the project list and selection unchanged when the picker is canceled", async () => {
    let runtimeChanges = 0;
    beforeSelectLocalSession = async () => {
      runtimeChanges++;
      return true;
    };
    hook = await renderHook(useHarness);
    const adding = hook.result.current.handleAddProject();
    await act(async () => {
      pendingPicks[0]!.resolve(null);
      await adding;
    });

    expect(hook.result.current.projects).toEqual([]);
    expect(hook.result.current.sessionIndices).toEqual({});
    expect(hook.result.current.activeProjectId).toBeNull();
    expect(runtimeChanges).toBe(0);
  });

  test("reopening a registered folder selects local before activating its project", async () => {
    diskProjects = [project];
    initialIndices = { [project.id]: activeIndex };
    const pending = deferred<boolean>();
    const checked: Array<string | null> = [];
    beforeSelectLocalSession = (id) => {
      checked.push(id);
      return pending.promise;
    };
    hook = await renderHook(useHarness);
    const adding = hook.result.current.handleAddProject();
    await act(async () => {
      pendingPicks[0]!.resolve(project);
      await flushMicrotasks();
    });
    expect(checked).toEqual([project.id]);
    expect(hook.result.current.activeProjectId).toBeNull();
    await act(async () => {
      pending.resolve(true);
      await adding;
    });
    expect(hook.result.current.activeProjectId).toBe(project.id);
    expect(hook.result.current.sessionIndices[project.id]).toBe(activeIndex);
  });

  test("does not open a local project when saving its location fails", async () => {
    diskProjects = [project];
    beforeSelectLocalSession = async () => false;
    hook = await renderHook(useHarness);
    const adding = hook.result.current.handleAddProject();
    await act(async () => {
      pendingPicks[0]!.resolve(project);
      await adding;
    });
    expect(hook.result.current.activeProjectId).toBeNull();
  });

  function seedLocalSession() {
    diskProjects = [project];
    initialIndices = {
      [project.id]: upsertImportedSession(project.id, {
        ...activeIndex.sessions[0]!,
        engineSessionId: "local-engine-session",
      }),
    };
  }

  function openLocalHistory(kind: "direct" | "disk" | "run") {
    const navigation = hook!.result.current;
    if (kind === "direct") return navigation.handleSelectSession(project.id, "travel-session");
    if (kind === "disk")
      return navigation.handleOpenAutomationDiskSession({
        id: "travel-session",
        engineSessionId: "local-engine-session",
        cwd: project.roots[0]!.path,
        title: "行程规划",
        updatedAt: 2,
      });
    return navigation.handleOpenAutomationRunSession({
      runId: "automation-run",
      sessionId: "local-engine-session",
      cwd: project.roots[0]!.path,
      objective: "行程规划",
      status: "completed",
      createdAt: 1,
      updatedAt: 2,
      startedAt: 1,
      finishedAt: 2,
      error: null,
      summary: null,
    });
  }

  test("keeps local selection mutations synchronous when no runtime guard is supplied", async () => {
    seedLocalSession();
    hook = await renderHook(useHarness);
    await act(async () => {
      const selected = openLocalHistory("direct");
      expect(hook!.result.current.activeBucketRef.current).toBe(
        bucketKey(project.id, "travel-session"),
      );
      expect(loadSessionIndex(project.id).activeSessionId).toBe("travel-session");
      await selected;
    });
    expect(hook.result.current.activeProjectId).toBe(project.id);
  });

  test.each(["direct", "disk", "run"] as const)(
    "%s awaits local runtime persistence before activating history",
    async (kind) => {
      seedLocalSession();
      const pending = deferred<boolean>();
      const checkedProjects: Array<string | null> = [];
      beforeSelectLocalSession = (projectId) => {
        checkedProjects.push(projectId);
        return pending.promise;
      };
      hook = await renderHook(useHarness);
      let completed = false;
      const opened = openLocalHistory(kind).then(() => {
        completed = true;
      });
      await flushMicrotasks();
      expect(checkedProjects).toEqual([project.id]);
      expect(completed).toBe(false);
      expect(hook.result.current.activeBucketRef.current).toBe("");
      expect(loadSessionIndex(project.id).activeSessionId).toBeNull();
      await act(async () => {
        pending.resolve(true);
        await opened;
      });
      expect(completed).toBe(true);
      expect(hook.result.current.activeProjectId).toBe(project.id);
      expect(hook.result.current.activeBucketRef.current).toBe(
        bucketKey(project.id, "travel-session"),
      );
    },
  );

  test.each(["disk", "run"] as const)(
    "a pending %s import cannot reopen history after a new conversation",
    async (kind) => {
      diskProjects = [project];
      const pending = deferred<Array<{ projectId: string; rootId: string; created: boolean }>>();
      window.codeshell.projectRegistry.resolveForCwdBatch = () => pending.promise;
      hook = await renderHook(useHarness);
      const opened = openLocalHistory(kind);
      await act(flushMicrotasks);
      await act(async () => {
        hook!.result.current.handleNewConversationForProject(project.id);
      });
      await act(async () => {
        pending.resolve([{ projectId: project.id, rootId: project.primaryRootId, created: false }]);
        await opened;
      });
      expect(loadSessionIndex(project.id).activeSessionId).toBeNull();
      expect(hook.result.current.activeBucketRef.current).toBe(bucketKey(project.id, null));
    },
  );

  test.each(["denied", "rejected"] as const)(
    "aborts activation when local runtime persistence is %s",
    async (reason) => {
      seedLocalSession();
      beforeSelectLocalSession = async () => {
        if (reason === "rejected") throw new Error("Persistence unavailable");
        return false;
      };
      hook = await renderHook(useHarness);
      await act(async () => {
        await openLocalHistory("direct");
      });
      expect(hook.result.current.activeProjectId).toBeNull();
      expect(hook.result.current.activeBucketRef.current).toBe("");
      expect(loadSessionIndex(project.id).activeSessionId).toBeNull();
    },
  );

  test.each(["disk", "run"] as const)(
    "%s imports history before awaiting local runtime activation",
    async (kind) => {
      diskProjects = [project];
      const pending = deferred<boolean>();
      let asked = false;
      beforeSelectLocalSession = () => {
        asked = true;
        return pending.promise;
      };
      hook = await renderHook(useHarness);
      let completed = false;
      const opened = openLocalHistory(kind).then(() => {
        completed = true;
      });
      await act(flushMicrotasks);
      expect(asked).toBe(true);
      expect(completed).toBe(false);
      expect(loadSessionIndex(project.id).sessions[0]!.engineSessionId).toBe(
        "local-engine-session",
      );
      expect(loadSessionIndex(project.id).activeSessionId).toBeNull();
      await act(async () => {
        pending.resolve(true);
        await opened;
      });
      expect(completed).toBe(true);
      expect(hook.result.current.activeProjectId).toBe(project.id);
      expect(loadSessionIndex(project.id).activeSessionId).toBe(
        kind === "disk" ? "travel-session" : "local-engine-session",
      );
    },
  );

  test("an older runtime completion cannot overwrite a newer selected local session", async () => {
    seedLocalSession();
    initialIndices[project.id] = upsertImportedSession(project.id, {
      id: "newer-session",
      engineSessionId: "newer-engine-session",
      title: "新会话",
      createdAt: 2,
      updatedAt: 3,
    });
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    let calls = 0;
    beforeSelectLocalSession = () => (calls++ === 0 ? first.promise : second.promise);
    hook = await renderHook(useHarness);
    const older = openLocalHistory("direct");
    const newer = hook.result.current.handleSelectSession(project.id, "newer-session");
    await act(async () => {
      second.resolve(true);
      await newer;
    });
    expect(loadSessionIndex(project.id).activeSessionId).toBe("newer-session");
    await act(async () => {
      first.resolve(true);
      await older;
    });
    expect(loadSessionIndex(project.id).activeSessionId).toBe("newer-session");
    expect(hook.result.current.activeBucketRef.current).toBe(
      bucketKey(project.id, "newer-session"),
    );
  });

  test.each(["direct", "disk", "run"] as const)(
    "a pending %s selection cannot reopen history after a new conversation",
    async (kind) => {
      seedLocalSession();
      const pending = deferred<boolean>();
      beforeSelectLocalSession = () => pending.promise;
      hook = await renderHook(useHarness);
      const opened = openLocalHistory(kind);
      await act(flushMicrotasks);
      await act(async () => {
        hook!.result.current.handleNewConversationForProject(project.id);
      });
      expect(loadSessionIndex(project.id).activeSessionId).toBeNull();
      await act(async () => {
        pending.resolve(true);
        await opened;
      });
      expect(loadSessionIndex(project.id).activeSessionId).toBeNull();
      expect(hook.result.current.activeBucketRef.current).toBe(bucketKey(project.id, null));
    },
  );

  test.each([true, false])(
    "rechecks disk navigation currency after runtime persistence (existing=%s)",
    async (existing) => {
      if (existing) seedLocalSession();
      else diskProjects = [project];
      const pending = deferred<boolean>();
      let asked = false;
      let current = true;
      beforeSelectLocalSession = () => {
        asked = true;
        return pending.promise;
      };
      hook = await renderHook(useHarness);
      const opened = hook.result.current.handleOpenAutomationDiskSession(
        {
          id: "travel-session",
          engineSessionId: "local-engine-session",
          cwd: project.roots[0]!.path,
          title: "行程规划",
          updatedAt: 2,
        },
        { isCurrent: () => current, validate: async () => true },
      );
      await act(flushMicrotasks);
      expect(asked).toBe(true);
      current = false;
      await act(async () => {
        pending.resolve(true);
        await opened;
      });
      expect(hook.result.current.activeProjectId).toBeNull();
      expect(hook.result.current.activeBucketRef.current).toBe("");
      expect(loadSessionIndex(project.id).activeSessionId).toBeNull();
    },
  );
});

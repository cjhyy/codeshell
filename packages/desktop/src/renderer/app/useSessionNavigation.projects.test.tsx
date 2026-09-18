import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useEffect, useState } from "react";
import type { LocalProject } from "../../preload/project-authority-types";
import {
  loadProjects,
  saveProjects,
  trackedProjectFromRegistry,
  type TrackedProject,
} from "../projects";
import type { SessionIndex } from "../transcripts";
import { ensureMiniDom, renderHook } from "../test-utils/renderHook";
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
  let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useHarness>>>> | undefined;

  function useHarness() {
    const [projects, setProjects] = useState<TrackedProject[]>([]);
    const [sessionIndices, setSessionIndices] = useState(initialIndices);
    const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
    useEffect(() => saveProjects(projects), [projects]);
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
    return { ...navigation, projects, sessionIndices, activeProjectId, setSessionIndices };
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
    hook = await renderHook(useHarness);
    const adding = hook.result.current.handleAddProject();
    await act(async () => {
      pendingPicks[0]!.resolve(null);
      await adding;
    });

    expect(hook.result.current.projects).toEqual([]);
    expect(hook.result.current.sessionIndices).toEqual({});
    expect(hook.result.current.activeProjectId).toBeNull();
  });
});

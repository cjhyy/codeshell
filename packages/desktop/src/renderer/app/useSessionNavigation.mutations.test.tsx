import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { loadProjects, saveProjects, type TrackedProject } from "../projects";
import { loadSessionIndex, saveSessionIndex, type SessionIndex } from "../transcripts";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { ToastProvider } from "../ui/ToastProvider";
import { useSessionNavigation } from "./useSessionNavigation";

const project: TrackedProject = {
  id: "project-a",
  name: "A",
  path: "/workspace/a",
  roots: [{ id: "root-a", path: "/workspace/a", name: "A", addedAt: 1 }],
  primaryRootId: "root-a",
  addedAt: 1,
};

const index: SessionIndex = {
  sessions: [
    { id: "ui-1", engineSessionId: "engine-1", title: "First", createdAt: 1, updatedAt: 2 },
    { id: "ui-2", title: "Second", createdAt: 1, updatedAt: 1 },
  ],
  activeSessionId: "ui-1",
};

describe("sidebar project and session mutations", () => {
  let savedStorage: PropertyDescriptor | undefined;
  let savedBridge: PropertyDescriptor | undefined;
  let savedProjects: TrackedProject[];
  let calls: string[];
  let logs: Array<{ event: string; data: unknown }>;
  let bridge: Record<string, any>;
  let root: Root | null;
  let result: { current: ReturnType<typeof useHarness> };

  function useHarness() {
    const [projects, setProjects] = useState<TrackedProject[]>([project]);
    const [sessionIndices, setSessionIndices] = useState<Record<string, SessionIndex>>({
      [project.id]: loadSessionIndex(project.id),
    });
    const [activeProjectId, setActiveProjectId] = useState<string | null>(project.id);
    const activeBucketRef = useRef("");
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
      onOpenTrace: () => {},
    });
    return { ...navigation, projects, sessionIndices };
  }

  async function mount(): Promise<void> {
    result = { current: undefined as unknown as ReturnType<typeof useHarness> };
    function Host(): null {
      result.current = useHarness();
      return null;
    }
    root = createRoot(document.createElement("div"));
    await act(async () => {
      root?.render(
        <ToastProvider>
          <Host />
        </ToastProvider>,
      );
      await flushMicrotasks();
    });
  }

  const errorToasts = () => logs.filter((entry) => entry.event === "ui.toast.error");

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
    saveProjects([project]);
    saveSessionIndex(project.id, index);
    calls = [];
    logs = [];
    bridge = {
      log: (event: string, data: unknown) => logs.push({ event, data }),
      releaseSessionWorkspace: async (id: string) => {
        calls.push(`release:${id}`);
        return { sessionId: id, ok: true, status: "released" };
      },
      releaseManySessionWorkspaces: async (ids: string[]) => {
        calls.push(`releaseMany:${ids.join(",")}`);
        return ids.map((id) => ({ sessionId: id, ok: true, status: "released" }));
      },
      setSessionArchived: async (id: string, archived: boolean) => {
        calls.push(`archive:${id}:${archived}`);
      },
      deleteSession: async (id: string) => {
        calls.push(`delete:${id}`);
      },
      projectRegistry: {
        remove: async (id: string) => {
          calls.push(`remove:${id}`);
        },
        rename: async (id: string, name: string) => {
          calls.push(`rename:${id}:${name}`);
        },
      },
    };
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      writable: true,
      value: bridge,
    });
    root = null;
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await flushMicrotasks();
    });
    saveProjects(savedProjects);
    if (savedStorage) Object.defineProperty(globalThis, "localStorage", savedStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (savedBridge) Object.defineProperty(window, "codeshell", savedBridge);
    else Reflect.deleteProperty(window, "codeshell");
  });

  test("removing a project detaches its Sessions before tombstoning the project authority", async () => {
    await mount();
    await act(async () => {
      await result.current.handleRemoveProject(project.id);
    });

    expect(calls).toEqual([
      "releaseMany:engine-1,ui-2",
      "archive:engine-1:true",
      "archive:ui-2:true",
      `remove:${project.id}`,
    ]);
    expect(result.current.projects).toEqual([]);
    expect(loadSessionIndex(project.id).sessions.every((session) => session.archived)).toBe(true);
  });

  test("a refused project removal keeps the project row and reports the failure", async () => {
    bridge.projectRegistry.remove = async () => {
      throw new Error("EACCES: permission denied");
    };
    await mount();
    await act(async () => {
      await result.current.handleRemoveProject(project.id);
    });

    expect(result.current.projects.map((item) => item.id)).toEqual([project.id]);
    // Core archived the Sessions before the refusal; the catalog matches it.
    expect(
      result.current.sessionIndices[project.id]!.sessions.every((session) => session.archived),
    ).toBe(true);
    expect(errorToasts()).toHaveLength(1);
    expect(JSON.stringify(errorToasts()[0]!.data)).toContain("EACCES");
  });
  test("a refused project rename restores the old name and reports the failure", async () => {
    bridge.projectRegistry.rename = async () => {
      throw new Error("EACCES: permission denied");
    };
    await mount();
    await act(async () => {
      await result.current.handleRenameProject(project.id, "Renamed");
    });

    expect(result.current.projects[0]!.displayName).toBeUndefined();
    expect(errorToasts()).toHaveLength(1);
    expect(JSON.stringify(errorToasts()[0]!.data)).toContain("EACCES");
  });

  test("a saved project rename keeps the new name", async () => {
    await mount();
    await act(async () => {
      await result.current.handleRenameProject(project.id, "Renamed");
    });

    expect(calls).toEqual([`rename:${project.id}:Renamed`]);
    expect(result.current.projects[0]!.displayName).toBe("Renamed");
    expect(errorToasts()).toEqual([]);
  });
  test("a failed sidebar delete keeps the Session row and reports the failure", async () => {
    bridge.deleteSession = async () => {
      throw new Error("EACCES: permission denied");
    };
    await mount();
    await act(async () => {
      await result.current.handleDeleteSession(project.id, "ui-1");
    });

    const ids = (value: SessionIndex) => value.sessions.map((session) => session.id);
    expect(ids(result.current.sessionIndices[project.id]!)).toEqual(["ui-1", "ui-2"]);
    expect(ids(loadSessionIndex(project.id))).toEqual(["ui-1", "ui-2"]);
    expect(loadSessionIndex(project.id).activeSessionId).toBe("ui-1");
    expect(errorToasts()).toHaveLength(1);
    expect(JSON.stringify(errorToasts()[0]!.data)).toContain("EACCES");
  });

  test("a sidebar delete removes the row once Main has deleted the Session", async () => {
    await mount();
    await act(async () => {
      await result.current.handleDeleteSession(project.id, "ui-1");
    });

    expect(calls).toEqual(["delete:engine-1"]);
    expect(
      result.current.sessionIndices[project.id]!.sessions.map((session) => session.id),
    ).toEqual(["ui-2"]);
    expect(errorToasts()).toEqual([]);
  });
});

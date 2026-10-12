import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useRef, useState } from "react";
import type { DiskSessionMeta } from "../automation/rebuildFromDisk";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import { loadSessionIndex, NO_REPO_KEY, saveSessionIndex, type SessionIndex } from "../transcripts";
import type { ViewState } from "../view";
import { OPEN_NOTIFICATION_SESSION_EVENT } from "./notificationSessionNavigation";
import { useNotificationSessionNavigation } from "./useNotificationSessionNavigation";
import { useSessionNavigation } from "./useSessionNavigation";

const index = (): SessionIndex => ({
  sessions: [
    { id: "local-id", engineSessionId: "engine-id", title: "Chat", createdAt: 1, updatedAt: 1 },
  ],
  activeSessionId: null,
});

describe("notification session entry points", () => {
  let oldStorage: PropertyDescriptor | undefined;
  let oldBridge: PropertyDescriptor | undefined;
  let hook: Awaited<ReturnType<typeof renderHook>> | undefined;
  let nativeOpen: ((sessionId: string) => void) | undefined;
  let unsubscribed: boolean;
  let indices: { current: Record<string, SessionIndex> };
  let selections: Array<[string | null, string]>;
  let imported: DiskSessionMeta[];
  let unavailable: string[];
  let listDiskSessions: (opts: { cursor?: string }) => Promise<{
    sessions: DiskSessionMeta[];
    nextCursor: string | null;
  }>;

  beforeEach(() => {
    ensureMiniDom();
    oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    oldBridge = Object.getOwnPropertyDescriptor(window, "codeshell");
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    nativeOpen = undefined;
    unsubscribed = false;
    indices = { current: { [NO_REPO_KEY]: index() } };
    selections = [];
    imported = [];
    unavailable = [];
    listDiskSessions = async () => ({ sessions: [], nextCursor: null });
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: {
        log: () => {},
        listDiskSessions: (opts: { cursor?: string }) => listDiskSessions(opts),
        onNotificationOpenSession: (listener: (sessionId: string) => void) => {
          nativeOpen = listener;
          return () => {
            unsubscribed = true;
            nativeOpen = undefined;
          };
        },
      },
    });
    saveSessionIndex(null, index());
  });

  afterEach(async () => {
    await hook?.unmount();
    hook = undefined;
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (oldBridge) Object.defineProperty(window, "codeshell", oldBridge);
    else Reflect.deleteProperty(window, "codeshell");
  });

  const mount = async () => {
    hook = await renderHook(() =>
      useNotificationSessionNavigation({
        sessionIndicesRef: indices,
        selectSession: (projectId, sessionId) => selections.push([projectId, sessionId]),
        openDiskSession: async (session) => {
          imported.push(session);
          saveSessionIndex(null, {
            activeSessionId: session.id,
            sessions: [
              {
                id: session.id,
                engineSessionId: session.engineSessionId,
                title: session.title,
                createdAt: session.updatedAt,
                updatedAt: session.updatedAt,
              },
            ],
          });
        },
        unavailable: (sessionId) => unavailable.push(sessionId),
      }),
    );
  };
  const settle = async (callback: () => void) => {
    await act(async () => {
      callback();
      await flushMicrotasks();
    });
  };
  const historyOpen = (sessionId: unknown) =>
    window.dispatchEvent(
      new CustomEvent(OPEN_NOTIFICATION_SESSION_EVENT, { detail: { sessionId } }),
    );

  const mountWithNavigation = async () => {
    const integrated = await renderHook(() => {
      const [sessionIndices, setSessionIndices] = useState(indices.current);
      const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
      const [view, setView] = useState<ViewState>({
        viewMode: "settings_page",
        sidebarCollapsed: false,
        inspectorCollapsed: false,
      });
      const activeBucketRef = useRef("__no_repo__::_none_");
      indices.current = sessionIndices;
      const navigation = useSessionNavigation({
        projects: [],
        setProjects: () => {},
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
        setView,
        setRunsInitialRunId: () => {},
      });
      useNotificationSessionNavigation({
        sessionIndicesRef: indices,
        selectSession: navigation.handleSelectSession,
        openDiskSession: navigation.handleOpenAutomationDiskSession,
        unavailable: (sessionId) => unavailable.push(sessionId),
      });
      return { sessionIndices, view, activeBucket: activeBucketRef.current };
    });
    hook = integrated;
    return integrated;
  };

  test("native clicks and history actions map to the same local conversation", async () => {
    await mount();
    await settle(() => nativeOpen!("engine-id"));
    await settle(() => historyOpen("engine-id"));
    expect(selections).toEqual([
      [null, "local-id"],
      [null, "local-id"],
    ]);
    expect(imported).toEqual([]);
    expect(unavailable).toEqual([]);
  });

  test("missing or deleted targets show an explanation without opening any conversation", async () => {
    await mount();
    await settle(() => historyOpen("missing-id"));
    saveSessionIndex(null, { sessions: [], activeSessionId: null });
    await settle(() => nativeOpen!("engine-id"));
    expect(unavailable).toEqual(["missing-id", "engine-id"]);
    expect(selections).toEqual([]);
    expect(imported).toEqual([]);
    await settle(() => {
      historyOpen(null);
      historyOpen(123);
      historyOpen("");
    });
    expect(unavailable).toHaveLength(2);
  });

  test("an existing disk record uses the normal disk-session importer", async () => {
    const session: DiskSessionMeta = {
      id: "disk-id",
      engineSessionId: "disk-engine",
      cwd: "/workspace",
      title: "Background work",
      updatedAt: 10,
      origin: "desktop",
    };
    listDiskSessions = async () => ({ sessions: [session], nextCursor: null });
    await mount();
    await settle(() => historyOpen("disk-engine"));
    expect(imported).toEqual([session]);
    expect(unavailable).toEqual([]);
  });

  test("an unreadable metadata catalog reports the target as unavailable", async () => {
    listDiskSessions = async () => {
      throw new Error("metadata unavailable");
    };
    await mount();
    await settle(() => nativeOpen!("missing-id"));
    expect(unavailable).toEqual(["missing-id"]);
    expect(selections).toEqual([]);
    expect(imported).toEqual([]);
  });

  test("a later click wins over an earlier metadata lookup", async () => {
    let finish!: (page: { sessions: DiskSessionMeta[]; nextCursor: null }) => void;
    listDiskSessions = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    await mount();
    await settle(() => historyOpen("slow-id"));
    await settle(() => nativeOpen!("engine-id"));
    await settle(() => finish({ sessions: [], nextCursor: null }));
    expect(selections).toEqual([[null, "local-id"]]);
    expect(unavailable).toEqual([]);
  });

  test("a disk importer waiting for roots cannot override a newer indexed notification click", async () => {
    let finishRoots!: (roots: Array<{ noRepo: true }>) => void;
    const session: DiskSessionMeta = {
      id: "disk-id",
      engineSessionId: "disk-engine",
      cwd: "/home/test/.code-shell/no-repo",
      title: "Background work",
      updatedAt: 10,
      origin: "desktop",
    };
    listDiskSessions = async () => ({ sessions: [session], nextCursor: null });
    Object.assign(window.codeshell, {
      projectRegistry: {
        resolveForCwdBatch: () =>
          new Promise((resolve) => {
            finishRoots = resolve;
          }),
      },
    });
    const integrated = await mountWithNavigation();
    await settle(() => historyOpen("disk-engine"));
    expect(typeof finishRoots).toBe("function");
    await settle(() => nativeOpen!("engine-id"));
    await settle(() => finishRoots([{ noRepo: true }]));
    expect(loadSessionIndex(null).activeSessionId).toBe("local-id");
    expect(loadSessionIndex(null).sessions.map((row) => row.id)).toEqual(["local-id"]);
    expect(integrated.result.current.activeBucket).toBe("__no_repo__::local-id");
    expect(integrated.result.current.view.viewMode).toBe("chat");
    expect(unavailable).toEqual([]);
  });

  test("a current disk importer revalidates metadata and opens the existing disk conversation", async () => {
    const session: DiskSessionMeta = {
      id: "disk-id",
      engineSessionId: "disk-engine",
      cwd: "/home/test/.code-shell/no-repo",
      title: "Background work",
      updatedAt: 10,
      origin: "desktop",
    };
    let metadataReads = 0;
    listDiskSessions = async () => {
      metadataReads += 1;
      return { sessions: [session], nextCursor: null };
    };
    Object.assign(window.codeshell, {
      projectRegistry: { resolveForCwdBatch: async () => [{ noRepo: true }] },
    });
    const integrated = await mountWithNavigation();
    await settle(() => historyOpen("disk-engine"));
    expect(metadataReads).toBe(2);
    expect(loadSessionIndex(null).activeSessionId).toBe("disk-id");
    expect(integrated.result.current.activeBucket).toBe("__no_repo__::disk-id");
    expect(unavailable).toEqual([]);
  });

  test("disk metadata deleted during root resolution cannot be resurrected by the importer", async () => {
    let finishRoots!: (roots: Array<{ noRepo: true }>) => void;
    let exists = true;
    const session: DiskSessionMeta = {
      id: "disk-id",
      engineSessionId: "disk-engine",
      cwd: "/home/test/.code-shell/no-repo",
      title: "Background work",
      updatedAt: 10,
      origin: "desktop",
    };
    listDiskSessions = async () => ({ sessions: exists ? [session] : [], nextCursor: null });
    Object.assign(window.codeshell, {
      projectRegistry: {
        resolveForCwdBatch: () =>
          new Promise((resolve) => {
            finishRoots = resolve;
          }),
      },
    });
    const integrated = await mountWithNavigation();
    await settle(() => historyOpen("disk-engine"));
    expect(typeof finishRoots).toBe("function");
    exists = false;
    await settle(() => finishRoots([{ noRepo: true }]));
    expect(loadSessionIndex(null).activeSessionId).toBeNull();
    expect(loadSessionIndex(null).sessions.map((row) => row.id)).toEqual(["local-id"]);
    expect(integrated.result.current.view.viewMode).toBe("settings_page");
    expect(unavailable).toEqual(["disk-engine"]);
  });

  test("unmount while the disk importer waits for roots prevents import and selection", async () => {
    let finishRoots!: (roots: Array<{ noRepo: true }>) => void;
    const session: DiskSessionMeta = {
      id: "disk-id",
      engineSessionId: "disk-engine",
      cwd: "/home/test/.code-shell/no-repo",
      title: "Background work",
      updatedAt: 10,
      origin: "desktop",
    };
    listDiskSessions = async () => ({ sessions: [session], nextCursor: null });
    Object.assign(window.codeshell, {
      projectRegistry: {
        resolveForCwdBatch: () =>
          new Promise((resolve) => {
            finishRoots = resolve;
          }),
      },
    });
    await mountWithNavigation();
    await settle(() => historyOpen("disk-engine"));
    expect(typeof finishRoots).toBe("function");
    await hook!.unmount();
    hook = undefined;
    await settle(() => finishRoots([{ noRepo: true }]));
    expect(loadSessionIndex(null).activeSessionId).toBeNull();
    expect(loadSessionIndex(null).sessions.map((row) => row.id)).toEqual(["local-id"]);
    expect(unavailable).toEqual([]);
  });

  test("unmount removes both subscriptions and ignores pending lookups", async () => {
    let finish!: (page: { sessions: DiskSessionMeta[]; nextCursor: null }) => void;
    listDiskSessions = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    await mount();
    await settle(() => historyOpen("slow-id"));
    await hook!.unmount();
    hook = undefined;
    await settle(() => {
      finish({ sessions: [], nextCursor: null });
      historyOpen("engine-id");
    });
    expect(unsubscribed).toBe(true);
    expect(selections).toEqual([]);
    expect(unavailable).toEqual([]);
  });
});

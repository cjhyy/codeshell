import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, type SetStateAction } from "react";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import { loadProjects, saveProjects, type TrackedProject } from "../projects";
import {
  bucketKey,
  loadSessionIndex,
  NO_REPO_KEY,
  saveSessionIndex,
  type SessionIndex,
} from "../transcripts";
import { compactSidebarSessions, sortSidebarSessions } from "../sidebarSessionVisibility";
import type { TranscriptsAction } from "../transcriptsReducer";
import { useHostSubscriptions } from "./useHostSubscriptions";

function cell<T>(value: T) {
  const state = {
    value,
    set(action: SetStateAction<T>) {
      state.value =
        typeof action === "function" ? (action as (current: T) => T)(state.value) : action;
    },
  };
  return state;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const project: TrackedProject = {
  id: "project",
  name: "CodeShell",
  path: "/work/codeshell",
  roots: [{ id: "root", path: "/work/codeshell", name: "CodeShell", addedAt: 1 }],
  primaryRootId: "root",
  addedAt: 1,
};
const announcement = (sessionId: string) => ({
  sessionId,
  cwd: project.path,
  title: "New work",
  prompt: "Check the document for changes",
  clientMessageId: `request:${sessionId}`,
});

describe("Mimi delegated Session sidebar announcements", () => {
  let hook: Awaited<ReturnType<typeof renderHook<void>>> | undefined;
  let savedStorage: PropertyDescriptor | undefined;
  let savedBridge: PropertyDescriptor | undefined;
  let savedProjects: TrackedProject[];
  let listeners: Map<string, (value: any) => void>;
  let indices: ReturnType<typeof cell<Record<string, SessionIndex>>>;
  let collapsed: ReturnType<typeof cell<Set<string>>>;
  let revealed: ReturnType<typeof cell<Record<string, string>>>;
  let params: Parameters<typeof useHostSubscriptions>[0];
  let actions: TranscriptsAction[];
  let busy: Set<string>;
  let resolveCwds: (cwds: string[]) => Promise<unknown[]>;

  beforeEach(() => {
    ensureMiniDom();
    savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    savedBridge = Object.getOwnPropertyDescriptor(window, "codeshell");
    savedProjects = loadProjects();
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
    saveProjects([project]);
    indices = cell<Record<string, SessionIndex>>({
      project: {
        sessions: Array.from({ length: 5 }, (_, index) => ({
          id: `pinned-${index}`,
          title: `Pinned ${index}`,
          createdAt: 1,
          updatedAt: 10 - index,
          pinned: true,
        })),
        activeSessionId: "pinned-4",
      },
      [NO_REPO_KEY]: { sessions: [], activeSessionId: null },
    });
    saveSessionIndex("project", indices.value.project!);
    collapsed = cell(new Set(["project", "unrelated"]));
    revealed = cell<Record<string, string>>({});
    actions = [];
    busy = new Set();
    listeners = new Map();
    resolveCwds = async () => [{ projectId: "project", rootId: "root", created: false }];
    const subscribe = (name: string) => (listener: (value: any) => void) => {
      listeners.set(name, listener);
      return () => {
        listeners.delete(name);
      };
    };
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: {
        log: () => {},
        projectRegistry: { resolveForCwdBatch: (cwds: string[]) => resolveCwds(cwds) },
        registerBrowserSessionBucket: () => {},
        ...Object.fromEntries(
          [
            "onStreamEvent",
            "onAutomationSession",
            "onMobileSession",
            "onPetDelegationSession",
            "onApprovalRequest",
            "onApprovalResolved",
            "onMobilePermissionMode",
            "onStatus",
            "onAgentLifecycle",
            "onWorktreeCleanupSkipped",
          ].map((name) => [name, subscribe(name)]),
        ),
      },
    });
    params = {
      services: {
        toast: () => {},
        t: ((key: string) => key) as any,
        dispatch: (action) => actions.push(action),
      },
      routing: {
        coalescersRef: { current: new Map() },
        coalescerSeqRef: { current: new Map() },
        appliedSeqRef: { current: new Map() },
        engineToBucketRef: { current: new Map() },
        sessionIndicesRef: { current: indices.value },
        runningBucketRef: { current: null },
        injectedSteerIdsRef: { current: new Set() },
        steeredIdsRef: { current: new Set() },
        activeBucketRef: { current: bucketKey("project", "pinned-4") },
        quickChatSessionsRef: { current: {} },
        transcriptsRef: { current: {} },
      },
      permissions: {
        approvalBucketsRef: { current: new Map() },
        permissionForBucketRef: { current: () => null },
        defaultPermissionModeRef: { current: null },
        setApprovalQueue: () => {},
        setApproval: () => {},
        setPermissionOverrides: () => {},
      },
      sessions: {
        setQueuedInputs: () => {},
        setUnreadBuckets: () => {},
        setSessionIndices: indices.set,
        setProjects: () => {},
        setQuickChatSessions: () => {},
        setCollapsedProjects: collapsed.set,
        setRevealedSessionIds: revealed.set,
      },
      activity: {
        mobileAnnounceSeqRef: { current: 0 },
        setLifecycle: () => {},
        setBusyKeys: () => {},
        setBusyForKey: (key, value) => {
          if (value) busy.add(key);
          else busy.delete(key);
        },
      },
    };
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

  test("reveals a new Session immediately without changing the active conversation", async () => {
    hook = await renderHook(() => useHostSubscriptions(params));
    await act(async () => {
      listeners.get("onPetDelegationSession")!(announcement("delegated"));
      await flushMicrotasks();
    });

    expect([...collapsed.value]).toEqual(["unrelated"]);
    expect(revealed.value.project).toBe("delegated");
    expect(indices.value.project!.activeSessionId).toBe("pinned-4");
    expect(params.routing.activeBucketRef.current).toBe(bucketKey("project", "pinned-4"));
    const visible = compactSidebarSessions(
      sortSidebarSessions(indices.value.project!.sessions),
      "pinned-4",
      false,
      5,
      undefined,
      revealed.value.project,
    );
    expect(visible.map((session) => session.id)).toEqual([
      "pinned-0",
      "pinned-1",
      "pinned-2",
      "pinned-4",
      "delegated",
    ]);
    const bucket = bucketKey("project", "delegated");
    expect(busy.has(bucket)).toBe(true);
    expect(params.routing.engineToBucketRef.current.get("delegated")).toBe(bucket);
    expect(params.routing.sessionIndicesRef.current).toEqual(indices.value);
    expect(actions).toContainEqual({
      type: "user_message",
      bucket,
      text: "Check the document for changes",
      clientMessageId: "request:delegated",
    });
  });

  test("a slower earlier announcement cannot hide the most recently delegated Session", async () => {
    const first = deferred<unknown[]>();
    let calls = 0;
    resolveCwds = () =>
      ++calls === 1
        ? first.promise
        : Promise.resolve([{ projectId: "project", rootId: "root", created: false }]);
    hook = await renderHook(() => useHostSubscriptions(params));
    await act(async () => {
      listeners.get("onPetDelegationSession")!(announcement("older"));
      listeners.get("onPetDelegationSession")!(announcement("newer"));
      await flushMicrotasks();
    });
    expect(revealed.value.project).toBe("newer");
    await act(async () => {
      first.resolve([{ projectId: "project", rootId: "root", created: false }]);
      await flushMicrotasks();
    });
    expect(revealed.value.project).toBe("newer");
    expect(indices.value.project!.sessions.map((session) => session.id)).toEqual(
      expect.arrayContaining(["older", "newer"]),
    );
    expect(params.routing.sessionIndicesRef.current).toEqual(indices.value);
  });

  test("reuses the existing local no-project Session identity", async () => {
    saveSessionIndex(null, {
      sessions: [
        {
          id: "local",
          engineSessionId: "delegated",
          title: "Saved title",
          createdAt: 1,
          updatedAt: 1,
          pinned: true,
        },
      ],
      activeSessionId: "local",
    });
    resolveCwds = async () => {
      throw new Error("Existing Sessions do not need cwd resolution");
    };
    hook = await renderHook(() => useHostSubscriptions(params));
    await act(async () => {
      listeners.get("onPetDelegationSession")!({ ...announcement("delegated"), cwd: "/no-repo" });
      await flushMicrotasks();
    });
    expect(loadSessionIndex(null).sessions).toHaveLength(1);
    expect(revealed.value[NO_REPO_KEY]).toBe("local");
    expect(params.routing.engineToBucketRef.current.get("delegated")).toBe(
      bucketKey(null, "local"),
    );
    expect(loadSessionIndex(null).sessions[0]).toMatchObject({
      id: "local",
      title: "Saved title",
      pinned: true,
    });
  });
});

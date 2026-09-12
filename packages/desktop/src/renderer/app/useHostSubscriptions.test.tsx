import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useReducer, type SetStateAction } from "react";
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
import { transcriptsReducer, type TranscriptsAction } from "../transcriptsReducer";
import { getSessionPersistence } from "../sessionPersistence";
import { useHostSubscriptions } from "./useHostSubscriptions";
import { INITIAL_STATE, type ApprovalState } from "../types";
import type { ApprovalRequestEnvelope } from "../../preload/types";

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

describe("host subscriptions and recovery", () => {
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
  let readApprovals: () => Promise<ApprovalRequestEnvelope[]>;
  let approvals: ReturnType<typeof cell<ApprovalRequestEnvelope[]>>;
  let currentApproval: ReturnType<typeof cell<ApprovalState>>;
  let approveCalls: unknown[][];
  const approval = (requestId = "approval-one", toolName = "Write"): ApprovalRequestEnvelope => ({
    sessionId: "pinned-1",
    requestId,
    request: {
      toolName,
      description: "Confirm the requested operation",
      args: {
        question: "Choose a target",
        options: [{ label: "Read only", description: "Inspect" }],
      },
      riskLevel: "medium",
    },
  });

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
    readApprovals = async () => [];
    approvals = cell<ApprovalRequestEnvelope[]>([]);
    currentApproval = cell<ApprovalState>(null);
    approveCalls = [];
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
        getPendingApprovals: () => readApprovals(),
        approve: async (...args: unknown[]) => {
          approveCalls.push(args);
        },
        mobileRemote: { notifyApprovalResolved: async () => {} },
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
        setApprovalQueue: approvals.set,
        setApproval: currentApproval.set,
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

  test("restores pending approvals after live listeners register and keeps the originating bucket", async () => {
    const read = deferred<ApprovalRequestEnvelope[]>();
    readApprovals = () => {
      expect(listeners.has("onApprovalRequest")).toBe(true);
      expect(listeners.has("onApprovalResolved")).toBe(true);
      return read.promise;
    };
    hook = await renderHook(() => useHostSubscriptions(params));
    const env = approval();
    await act(async () => {
      listeners.get("onApprovalRequest")!(env);
      read.resolve([env, env]);
      await flushMicrotasks();
      listeners.get("onApprovalRequest")!(env);
    });
    expect(approvals.value).toEqual([env]);
    expect(currentApproval.value).toEqual(env);
    expect(params.permissions.approvalBucketsRef.current.get(env.requestId)).toBe(
      bucketKey("project", "pinned-1"),
    );
    expect(params.routing.activeBucketRef.current).toBe(bucketKey("project", "pinned-4"));
    expect(approveCalls).toEqual([]);
  });

  test("a resolved request wins over an older in-flight snapshot, even without a live request", async () => {
    const read = deferred<ApprovalRequestEnvelope[]>();
    readApprovals = () => read.promise;
    hook = await renderHook(() => useHostSubscriptions(params));
    const shown = approval("shown");
    const missed = approval("missed");
    await act(async () => {
      listeners.get("onApprovalRequest")!(shown);
      listeners.get("onApprovalResolved")!({ requestId: shown.requestId, approved: true });
      listeners.get("onApprovalResolved")!({ requestId: missed.requestId, approved: false });
      read.resolve([shown, missed]);
      await flushMicrotasks();
    });
    expect(approvals.value).toEqual([]);
    expect(currentApproval.value).toBe(null);
    expect(params.permissions.approvalBucketsRef.current.size).toBe(0);
  });

  test("snapshot restoration preserves bypass scope and delivers ask_user once without auto-answering", async () => {
    const read = deferred<ApprovalRequestEnvelope[]>();
    readApprovals = () => read.promise;
    const ownBucket = bucketKey("project", "pinned-1");
    params.permissions.permissionForBucketRef.current = (bucket) =>
      bucket === ownBucket ? "bypass" : null;
    hook = await renderHook(() => useHostSubscriptions(params));
    const write = approval("write");
    const ask = approval("question", "__ask_user__");
    await act(async () => {
      listeners.get("onApprovalRequest")!(write);
      listeners.get("onApprovalRequest")!(ask);
      read.resolve([write, ask]);
      await flushMicrotasks();
    });
    expect(approveCalls).toEqual([["pinned-1", "write", "approve"]]);
    expect(approvals.value).toEqual([]);
    expect(actions).toEqual([
      expect.objectContaining({
        type: "ask_user",
        bucket: ownBucket,
        engineSessionId: "pinned-1",
        requestId: "question",
        question: "Choose a target",
      }),
    ]);
  });

  test("worker exit invalidates an in-flight snapshot and permits current worker request ids", async () => {
    const read = deferred<ApprovalRequestEnvelope[]>();
    readApprovals = () => read.promise;
    params.permissions.permissionForBucketRef.current = () => "bypass";
    hook = await renderHook(() => useHostSubscriptions(params));
    await act(async () => {
      listeners.get("onApprovalRequest")!(approval("reused"));
      listeners.get("onAgentLifecycle")!({ type: "exited", code: null });
      read.resolve([approval("old-worker")]);
      await flushMicrotasks();
      listeners.get("onApprovalRequest")!(approval("reused"));
    });
    expect(approveCalls).toEqual([
      ["pinned-1", "reused", "approve"],
      ["pinned-1", "reused", "approve"],
    ]);
    expect(approvals.value).toEqual([]);
  });

  test("an unmounted renderer ignores a late approval snapshot", async () => {
    const read = deferred<ApprovalRequestEnvelope[]>();
    readApprovals = () => read.promise;
    hook = await renderHook(() => useHostSubscriptions(params));
    await hook.unmount();
    hook = undefined;
    read.resolve([approval()]);
    await flushMicrotasks();
    expect(approvals.value).toEqual([]);
  });

  test("a dead Core worker retires its visible approvals but preserves external runtime prompts", async () => {
    hook = await renderHook(() => useHostSubscriptions(params));
    const native = approval("native");
    const external: ApprovalRequestEnvelope = {
      ...approval("external"),
      source: "external-runtime",
    };
    await act(async () => {
      listeners.get("onApprovalRequest")!(native);
      listeners.get("onApprovalRequest")!(external);
      expect(currentApproval.value?.requestId).toBe("native");
      listeners.get("onAgentLifecycle")!({ type: "exited", code: null });
    });
    expect(approvals.value).toEqual([external]);
    expect(currentApproval.value).toEqual(external);
    expect([...params.permissions.approvalBucketsRef.current.keys()]).toEqual(["external"]);
    await act(async () => {
      listeners.get("onApprovalRequest")!(external);
      listeners.get("onApprovalRequest")!(native);
    });
    expect(approvals.value).toEqual([external, native]);
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

  test("quit flush commits coalesced events to React before a snapshot reader runs", async () => {
    const snapshot = { revision: 0, indices: {} };
    const writes: string[] = [];
    window.codeshell.sessionCatalog = {
      load: async () => snapshot,
      importLegacy: async () => snapshot,
      apply: async () => snapshot,
      onChanged: () => () => undefined,
      readTranscript: async () => ({ value: null, hasEarlier: false }),
      writeTranscript: async ({ value }) => {
        writes.push(value);
      },
      deleteTranscript: async () => undefined,
    };
    const persistence = getSessionPersistence()!;
    const bucket = bucketKey("project", "pinned-4");
    params.routing.engineToBucketRef.current.set("engine", bucket);
    const unsubscribe = persistence.subscribeBeforeFlush(() => {
      const state = params.routing.transcriptsRef.current[bucket];
      if (state) persistence.saveTranscript("project", "pinned-4", JSON.stringify(state));
    });
    try {
      hook = await renderHook(() => {
        const [transcripts, dispatch] = useReducer(transcriptsReducer, {});
        params.services.dispatch = dispatch;
        params.routing.transcriptsRef.current = transcripts;
        useHostSubscriptions(params);
      });
      listeners.get("onStreamEvent")!({
        sessionId: "engine",
        seq: 1,
        event: { type: "stream_request_start", turnNumber: 1, messageId: "last" },
      });
      listeners.get("onStreamEvent")!({
        sessionId: "engine",
        seq: 2,
        event: { type: "text_delta", text: "Last buffered words" },
      });
      expect(params.routing.transcriptsRef.current[bucket]).toBeUndefined();
      await act(async () => {
        await persistence.flush();
      });
      expect(writes).toHaveLength(1);
      expect(JSON.parse(writes[0]!).messages).toContainEqual(
        expect.objectContaining({ id: "last", text: "Last buffered words" }),
      );
      expect(JSON.parse(writes[0]!).snapshotSeq).toBe(2);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
      });
      expect(params.routing.transcriptsRef.current[bucket]!.messages).toHaveLength(1);
    } finally {
      unsubscribe();
    }
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

  test("live completion remains immediate while recovery preserves exact coalesced sequences", async () => {
    const bucket = bucketKey("project", "pinned-4");
    params.routing.engineToBucketRef.current.set("engine", bucket);
    busy.add(bucket);
    hook = await renderHook(() => {
      const [transcripts, dispatch] = useReducer(
        transcriptsReducer,
        transcriptsReducer({}, { type: "hydrate_begin", bucket, token: 1 }),
      );
      params.services.dispatch = dispatch;
      params.routing.transcriptsRef.current = transcripts;
      useHostSubscriptions(params);
    });
    await act(async () => {
      for (const [seq, event] of [
        [10, { type: "text_delta", text: "prefix" }],
        [11, { type: "text_delta", text: " tail" }],
        [12, { type: "turn_complete" }],
      ] as const)
        listeners.get("onStreamEvent")!({ sessionId: "engine", seq, event });
      expect(busy.has(bucket)).toBe(false);
      params.routing.coalescersRef.current.get(bucket)!.flush();
      await flushMicrotasks();
    });
    expect(params.routing.appliedSeqRef.current.has(bucket)).toBe(false);
    await act(async () => {
      params.services.dispatch({
        type: "hydrate_history",
        bucket,
        token: 1,
        history: INITIAL_STATE,
        state: INITIAL_STATE,
        goalAtStart: null,
        snapshot: [
          {
            seq: 9,
            event: { type: "stream_request_start", turnNumber: 1, messageId: "recovered" },
          },
          { seq: 10, event: { type: "text_delta", text: "prefix" } },
        ],
      });
      await flushMicrotasks();
    });
    expect(params.routing.transcriptsRef.current[bucket]?.messages).toContainEqual(
      expect.objectContaining({ id: "recovered", text: "prefix tail", done: true }),
    );
    expect(params.routing.transcriptsRef.current[bucket]?.snapshotSeq).toBe(12);
    expect(busy.has(bucket)).toBe(false);
  });

  test("preserves a delegated run that starts and finishes before its sidebar placement resolves", async () => {
    const placement = deferred<unknown[]>();
    resolveCwds = () => placement.promise;
    const activeBucket = params.routing.activeBucketRef.current;
    params.routing.runningBucketRef.current = activeBucket;
    busy.add(activeBucket);
    hook = await renderHook(() => useHostSubscriptions(params));
    await act(async () => {
      listeners.get("onStreamEvent")!({
        sessionId: "delegated",
        seq: 1,
        event: { type: "session_started", sessionId: "delegated" },
      });
      listeners.get("onPetDelegationSession")!(announcement("delegated"));
      listeners.get("onStreamEvent")!({
        sessionId: "delegated",
        seq: 2,
        event: { type: "text_delta", text: "The document is ready." },
      });
      listeners.get("onStreamEvent")!({
        sessionId: "delegated",
        seq: 3,
        event: { type: "turn_complete" },
      });
      await flushMicrotasks();
    });
    expect(busy.has(activeBucket)).toBe(true);
    expect(params.routing.runningBucketRef.current).toBe(activeBucket);
    expect(actions).toEqual([]);

    await act(async () => {
      placement.resolve([{ projectId: "project", rootId: "root", created: false }]);
      await flushMicrotasks();
      params.routing.coalescersRef.current.get(bucketKey("project", "delegated"))?.flush();
    });
    const bucket = bucketKey("project", "delegated");
    expect(revealed.value.project).toBe("delegated");
    expect(busy.has(bucket)).toBe(false);
    expect(busy.has(activeBucket)).toBe(true);
    expect(actions[0]).toMatchObject({ type: "user_message", bucket });
    expect(actions[1]).toMatchObject({
      type: "stream_batch",
      bucket,
      maxSeq: 3,
      events: [
        { type: "session_started", sessionId: "delegated" },
        { type: "text_delta", text: "The document is ready.", agentId: undefined },
        { type: "turn_complete" },
      ],
    });
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

  test("retains startup and completion when the unbound event buffer reaches its limit", async () => {
    hook = await renderHook(() => useHostSubscriptions(params));
    await act(async () => {
      const stream = listeners.get("onStreamEvent")!;
      stream({
        sessionId: "delegated",
        event: { type: "session_started", sessionId: "delegated" },
      });
      for (let index = 0; index < 2_050; index++) {
        stream({ sessionId: "delegated", event: { type: "text_delta", text: "x" } });
      }
      stream({ sessionId: "delegated", event: { type: "turn_complete" } });
      listeners.get("onPetDelegationSession")!(announcement("delegated"));
      await flushMicrotasks();
      params.routing.coalescersRef.current.get(bucketKey("project", "delegated"))?.flush();
    });
    expect(busy.has(bucketKey("project", "delegated"))).toBe(false);
    const batch = actions.find((action) => action.type === "stream_batch");
    expect(batch).toMatchObject({
      type: "stream_batch",
      events: [
        { type: "session_started", sessionId: "delegated" },
        { type: "text_delta", text: "x".repeat(2_046) },
        { type: "turn_complete" },
      ],
    });
  });
});

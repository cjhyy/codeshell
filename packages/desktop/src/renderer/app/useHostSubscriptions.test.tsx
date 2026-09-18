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
import { INITIAL_STATE, type ApprovalState, type AskUserMessage } from "../types";
import type { ApprovalRequestEnvelope } from "../../preload/types";
import type { PermissionMode } from "../chat/PermissionPill";

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
  let permissionReads: string[];
  let readPermissionSettings: (sessionId: string) => Promise<Record<string, unknown> | null>;
  let userSettings: Record<string, unknown>;
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
    permissionReads = [];
    readPermissionSettings = async () => ({});
    userSettings = {};
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
        getConfigurationSettings: ({ sessionId }: { sessionId: string }) => {
          permissionReads.push(sessionId);
          return readPermissionSettings(sessionId);
        },
        getSettings: async () => userSettings,
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
        permissionOverrideForBucketRef: { current: () => null },
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
    params.permissions.permissionOverrideForBucketRef.current = (bucket) =>
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

  test("reload retires expired external cards while retaining real pending and native questions", async () => {
    const read = deferred<ApprovalRequestEnvelope[]>();
    readApprovals = () => read.promise;
    const bucket = bucketKey("project", "pinned-1");
    const questions: AskUserMessage[] = [
      "external-approval-expired",
      "external-approval-live",
      "native-question",
    ].map((requestId) => ({
      kind: "ask_user",
      id: requestId,
      requestId,
      engineSessionId: "pinned-1",
      question: "Choose a target",
      multiSelect: false,
    }));
    questions.push({
      ...questions[0]!,
      id: "answered",
      requestId: "external-approval-answered",
      answer: "Original answer",
    });
    hook = await renderHook(() => {
      const [transcripts, dispatch] = useReducer(transcriptsReducer, {
        [bucket]: { ...INITIAL_STATE, messages: questions },
      });
      params.services.dispatch = dispatch;
      params.routing.transcriptsRef.current = transcripts;
      useHostSubscriptions(params);
    });
    expect(params.routing.transcriptsRef.current[bucket]!.messages[0]).not.toHaveProperty("answer");
    await act(async () => {
      read.resolve([
        { ...approval("external-approval-live", "__ask_user__"), source: "external-runtime" },
      ]);
      await flushMicrotasks();
    });
    const messages = params.routing.transcriptsRef.current[bucket]!.messages;
    expect(messages).toContainEqual(
      expect.objectContaining({
        requestId: "external-approval-expired",
        answer: "msg.ask.cancelled",
      }),
    );
    expect(
      messages.find(
        (message) => message.kind === "ask_user" && message.requestId === "external-approval-live",
      ),
    ).not.toHaveProperty("answer");
    expect(
      messages.find(
        (message) => message.kind === "ask_user" && message.requestId === "native-question",
      ),
    ).not.toHaveProperty("answer");
    expect(messages).toContainEqual(
      expect.objectContaining({
        requestId: "external-approval-answered",
        answer: "Original answer",
      }),
    );
    expect(approveCalls).toEqual([]);
  });

  test("a timeout still retires a card hydrated after the pending snapshot and resolution", async () => {
    const bucket = bucketKey("project", "pinned-1");
    hook = await renderHook(() => {
      const [transcripts, dispatch] = useReducer(transcriptsReducer, {});
      params.services.dispatch = dispatch;
      params.routing.transcriptsRef.current = transcripts;
      useHostSubscriptions(params);
    });
    await act(async () => {
      listeners.get("onApprovalResolved")!({
        requestId: "external-approval-timeout",
        sessionId: "pinned-1",
      });
      const cached = {
        ...INITIAL_STATE,
        messages: [
          {
            kind: "ask_user" as const,
            id: "old",
            requestId: "external-approval-timeout",
            question: "Old question",
            multiSelect: false,
          },
        ],
      };
      params.services.dispatch({
        type: "hydrate_history",
        bucket,
        state: cached,
        history: cached,
        goalAtStart: null,
      });
      await flushMicrotasks();
    });
    expect(params.routing.transcriptsRef.current[bucket]!.messages).toContainEqual(
      expect.objectContaining({
        requestId: "external-approval-timeout",
        answer: "msg.ask.timedOut",
      }),
    );
  });

  test("external resolution wins over stale replay while a newer live question remains pending", async () => {
    const read = deferred<ApprovalRequestEnvelope[]>();
    readApprovals = () => read.promise;
    const bucket = bucketKey("project", "pinned-1");
    hook = await renderHook(() => {
      const [transcripts, dispatch] = useReducer(transcriptsReducer, {});
      params.services.dispatch = dispatch;
      params.routing.transcriptsRef.current = transcripts;
      useHostSubscriptions(params);
    });
    const old = {
      ...approval("external-approval-old", "__ask_user__"),
      source: "external-runtime" as const,
    };
    const current = {
      ...approval("external-approval-new", "__ask_user__"),
      source: "external-runtime" as const,
    };
    await act(async () => {
      listeners.get("onApprovalRequest")!(old);
      listeners.get("onApprovalResolved")!({
        requestId: old.requestId,
        sessionId: old.sessionId,
        approved: false,
      });
      listeners.get("onApprovalRequest")!(current);
      read.resolve([old]);
      await flushMicrotasks();
    });
    const messages = params.routing.transcriptsRef.current[bucket]!.messages;
    expect(messages).toContainEqual(
      expect.objectContaining({ requestId: old.requestId, answer: "msg.ask.cancelled" }),
    );
    expect(
      messages.find(
        (message) => message.kind === "ask_user" && message.requestId === current.requestId,
      ),
    ).not.toHaveProperty("answer");
    expect(messages).toHaveLength(2);
  });

  test("Core exit does not discard an external request in the in-flight recovery snapshot", async () => {
    const read = deferred<ApprovalRequestEnvelope[]>();
    readApprovals = () => read.promise;
    hook = await renderHook(() => useHostSubscriptions(params));
    const external = {
      ...approval("external-approval-survivor"),
      source: "external-runtime" as const,
    };
    await act(async () => {
      listeners.get("onAgentLifecycle")!({ type: "exited", code: null });
      read.resolve([approval("native-old"), external]);
      await flushMicrotasks();
    });
    expect(approvals.value).toEqual([external]);
  });

  test("legacy external questions at the request root retain their text and choices", async () => {
    hook = await renderHook(() => useHostSubscriptions(params));
    const legacy = {
      sessionId: "pinned-1",
      requestId: "legacy-question",
      request: {
        toolName: "__ask_user__",
        question: "Which date should the comparison start from?",
        header: "Date",
        options: [{ label: "This year", description: "Use January 1" }],
        multiSelect: true,
      },
    };
    await act(async () => {
      listeners.get("onApprovalRequest")!(legacy);
      await flushMicrotasks();
    });
    expect(actions).toContainEqual(
      expect.objectContaining({
        type: "ask_user",
        requestId: "legacy-question",
        question: legacy.request.question,
        header: "Date",
        options: legacy.request.options,
        multiSelect: true,
      }),
    );
    expect(approveCalls).toEqual([]);
  });

  test("canonical question fields override legacy fields and blank text uses the description", async () => {
    hook = await renderHook(() => useHostSubscriptions(params));
    const canonical = approval("canonical-question", "__ask_user__");
    Object.assign(canonical.request, {
      question: "Old question",
      options: [{ label: "Old", description: "Old choice" }],
    });
    const blank = approval("blank-question", "__ask_user__");
    blank.request.args = { question: " \n " };
    blank.request.description = "Please specify the comparison period";
    await act(async () => {
      listeners.get("onApprovalRequest")!(canonical);
      listeners.get("onApprovalRequest")!(blank);
      await flushMicrotasks();
    });
    expect(actions).toContainEqual(
      expect.objectContaining({
        type: "ask_user",
        requestId: "canonical-question",
        question: "Choose a target",
        options: canonical.request.args.options,
      }),
    );
    expect(actions).toContainEqual(
      expect.objectContaining({
        type: "ask_user",
        requestId: "blank-question",
        question: blank.request.description,
      }),
    );
    expect(approveCalls).toEqual([]);
  });

  test("background full access works while the foreground draft has no configuration", async () => {
    params.routing.activeBucketRef.current = "other-project::empty-draft";
    userSettings = { permissionMode: "bypass" };
    hook = await renderHook(() => useHostSubscriptions(params));
    await act(async () => {
      listeners.get("onApprovalRequest")!(approval());
      await flushMicrotasks();
    });
    expect(permissionReads).toEqual(["pinned-1"]);
    expect(approveCalls).toEqual([["pinned-1", "approval-one", "approve"]]);
    expect(approvals.value).toEqual([]);
  });

  test("the target project default overrides global full access across permission aliases", async () => {
    userSettings = { permissionMode: "bypass" };
    readPermissionSettings = async () => ({ permissions: { defaultMode: "default" } });
    hook = await renderHook(() => useHostSubscriptions(params));
    const env = approval();
    await act(async () => {
      listeners.get("onApprovalRequest")!(env);
      await flushMicrotasks();
    });
    expect(approveCalls).toEqual([]);
    expect(approvals.value).toEqual([env]);
  });

  test("an unknown target cannot borrow the foreground override or global full access", async () => {
    userSettings = { permissions: { defaultMode: "bypassPermissions" } };
    params.permissions.permissionOverrideForBucketRef.current = () => "bypass";
    readPermissionSettings = async () => {
      throw new Error("unknown session");
    };
    hook = await renderHook(() => useHostSubscriptions(params));
    const env = { ...approval(), sessionId: "unknown" };
    await act(async () => {
      listeners.get("onApprovalRequest")!(env);
      await flushMicrotasks();
    });
    expect(permissionReads).toEqual(["unknown"]);
    expect(approveCalls).toEqual([]);
    expect(approvals.value).toEqual([env]);
  });

  test("a permission downgrade during lookup wins over full access from settings", async () => {
    const read = deferred<Record<string, unknown>>();
    readPermissionSettings = () => read.promise;
    hook = await renderHook(() => useHostSubscriptions(params));
    const env = approval();
    await act(async () => {
      listeners.get("onApprovalRequest")!(env);
      params.permissions.permissionOverrideForBucketRef.current = () => "default";
      read.resolve({ permissionMode: "bypass" });
      await flushMicrotasks();
    });
    expect(approveCalls).toEqual([]);
    expect(approvals.value).toEqual([env]);
  });

  test("a newly resolved target route supplies the latest permission override", async () => {
    const read = deferred<Record<string, unknown>>();
    readPermissionSettings = () => read.promise;
    hook = await renderHook(() => useHostSubscriptions(params));
    const env = { ...approval(), sessionId: "late-route" };
    const ownBucket = "other-project::late-route";
    await act(async () => {
      listeners.get("onApprovalRequest")!(env);
      params.routing.engineToBucketRef.current.set(env.sessionId, ownBucket);
      params.permissions.permissionOverrideForBucketRef.current = (bucket) =>
        bucket === ownBucket ? "default" : null;
      read.resolve({ permissionMode: "bypass" });
      await flushMicrotasks();
    });
    expect(approveCalls).toEqual([]);
    expect(approvals.value).toEqual([env]);
    expect(params.permissions.approvalBucketsRef.current.get(env.requestId)).toBe(ownBucket);
  });

  test("a live Quick Chat keeps its explicit permission before its route table is populated", async () => {
    const sessionId = "qchat-cold-route";
    const bucket = `__quick_chat__::${sessionId}`;
    params.routing.quickChatSessionsRef.current = {
      quick: {
        key: "quick",
        ownerBucket: "project::pinned-1",
        tabId: "quick",
        sessionId,
        bucket,
        cwd: "/work/codeshell",
        sourceSessionId: "pinned-1",
        contextMode: "blank",
        status: "ready",
        creationNonce: "nonce",
      },
    };
    params.permissions.permissionOverrideForBucketRef.current = (target) =>
      target === bucket ? "default" : null;
    userSettings = { permissionMode: "bypass" };
    hook = await renderHook(() => useHostSubscriptions(params));
    const env = { ...approval(), sessionId };
    await act(async () => {
      listeners.get("onApprovalRequest")!(env);
      await flushMicrotasks();
    });
    expect(permissionReads).toEqual([]);
    expect(approveCalls).toEqual([]);
    expect(approvals.value).toEqual([env]);
  });

  test("an explicit mobile restriction is retained for its own session", async () => {
    const overrides = cell<Record<string, PermissionMode>>({});
    params.permissions.setPermissionOverrides = overrides.set;
    hook = await renderHook(() => useHostSubscriptions(params));
    await act(async () => {
      listeners.get("onMobilePermissionMode")!({ sessionId: "pinned-1", mode: "default" });
    });
    expect(overrides.value).toEqual({ [bucketKey("project", "pinned-1")]: "default" });
  });

  test("a resolved approval cannot be approved or displayed after its settings arrive", async () => {
    const read = deferred<Record<string, unknown>>();
    readPermissionSettings = () => read.promise;
    hook = await renderHook(() => useHostSubscriptions(params));
    await act(async () => {
      listeners.get("onApprovalRequest")!(approval());
      listeners.get("onApprovalResolved")!({ requestId: "approval-one", approved: false });
      read.resolve({ permissionMode: "bypass" });
      await flushMicrotasks();
    });
    expect(approveCalls).toEqual([]);
    expect(approvals.value).toEqual([]);
  });

  test("an old permission lookup cannot approve a replacement worker's reused request id", async () => {
    const oldRead = deferred<Record<string, unknown>>();
    const newRead = deferred<Record<string, unknown>>();
    readPermissionSettings = () =>
      permissionReads.length === 1 ? oldRead.promise : newRead.promise;
    hook = await renderHook(() => useHostSubscriptions(params));
    const env = approval("reused");
    await act(async () => {
      listeners.get("onApprovalRequest")!(env);
      listeners.get("onAgentLifecycle")!({ type: "exited", code: null });
      listeners.get("onApprovalRequest")!(env);
      oldRead.resolve({ permissionMode: "bypass" });
      await flushMicrotasks();
      expect(approveCalls).toEqual([]);
      expect(approvals.value).toEqual([]);
      newRead.resolve({ permissionMode: "default" });
      await flushMicrotasks();
    });
    expect(approveCalls).toEqual([]);
    expect(approvals.value).toEqual([env]);
  });

  test("unmount cancels a pending automatic permission decision", async () => {
    const read = deferred<Record<string, unknown>>();
    readPermissionSettings = () => read.promise;
    hook = await renderHook(() => useHostSubscriptions(params));
    listeners.get("onApprovalRequest")!(approval());
    await hook.unmount();
    hook = undefined;
    read.resolve({ permissionMode: "bypass" });
    await flushMicrotasks();
    expect(approveCalls).toEqual([]);
    expect(approvals.value).toEqual([]);
  });

  test("a language change restores approvals whose permission lookup was in flight", async () => {
    const oldRead = deferred<Record<string, unknown>>();
    const newRead = deferred<Record<string, unknown>>();
    readPermissionSettings = () =>
      permissionReads.length === 1 ? oldRead.promise : newRead.promise;
    hook = await renderHook(() => useHostSubscriptions(params));
    const env = approval();
    listeners.get("onApprovalRequest")!(env);
    readApprovals = async () => [env];
    params.services.t = ((key: string) => `translated:${key}`) as any;
    await hook.rerender();
    expect(permissionReads).toEqual(["pinned-1", "pinned-1"]);
    await act(async () => {
      oldRead.resolve({ permissionMode: "bypass" });
      await flushMicrotasks();
      expect(approveCalls).toEqual([]);
      newRead.resolve({ permissionMode: "default" });
      await flushMicrotasks();
    });
    expect(approveCalls).toEqual([]);
    expect(approvals.value).toEqual([env]);
  });

  test("a failed automatic approval stays reviewable without publishing a false resolution", async () => {
    const mirrored: unknown[] = [];
    params.permissions.permissionOverrideForBucketRef.current = () => "bypass";
    window.codeshell.approve = async () => {
      throw new Error("worker unavailable");
    };
    window.codeshell.mobileRemote.notifyApprovalResolved = async (env) => {
      mirrored.push(env);
    };
    hook = await renderHook(() => useHostSubscriptions(params));
    const env = approval();
    await act(async () => {
      listeners.get("onApprovalRequest")!(env);
      await flushMicrotasks();
    });
    expect(approvals.value).toEqual([env]);
    expect(mirrored).toEqual([]);
  });

  test("a JSON-RPC error response is not advertised as successful approval", async () => {
    const mirrored: unknown[] = [];
    params.permissions.permissionOverrideForBucketRef.current = () => "bypass";
    window.codeshell.approve = async () => ({
      jsonrpc: "2.0",
      id: "rpc-1",
      error: { code: -32004, message: "No such session" },
    });
    window.codeshell.mobileRemote.notifyApprovalResolved = async (env) => {
      mirrored.push(env);
    };
    hook = await renderHook(() => useHostSubscriptions(params));
    const env = approval();
    await act(async () => {
      listeners.get("onApprovalRequest")!(env);
      await flushMicrotasks();
    });
    expect(approvals.value).toEqual([env]);
    expect(mirrored).toEqual([]);
  });

  test("asynchronous questions survive turn completion and resolve with the actual remote answer", async () => {
    const bucket = bucketKey("project", "pinned-1");
    params.routing.engineToBucketRef.current.set("pinned-1", bucket);
    params.services.dispatch = (action) => {
      actions.push(action);
      params.routing.transcriptsRef.current = transcriptsReducer(
        params.routing.transcriptsRef.current,
        action,
      );
    };
    const question = approval("async-question", "__ask_user__");
    question.request.args = { ...question.request.args, asynchronous: true };
    readApprovals = async () => [question];
    hook = await renderHook(() => useHostSubscriptions(params));
    await act(async () => {
      listeners.get("onStreamEvent")!({
        sessionId: "pinned-1",
        event: { type: "turn_complete", reason: "completed" },
      });
      await flushMicrotasks();
    });
    const pending = params.routing.transcriptsRef.current[bucket]?.messages.find(
      (message) => message.kind === "ask_user",
    );
    expect(pending).toMatchObject({
      requestId: "async-question",
      asynchronous: true,
      engineSessionId: "pinned-1",
    });
    expect(pending).not.toHaveProperty("answer");
    expect(approveCalls).toEqual([]);
    await act(async () => {
      listeners.get("onApprovalResolved")!({
        requestId: "async-question",
        sessionId: "pinned-1",
        approved: true,
        answer: "Read only",
      });
      await flushMicrotasks();
    });
    expect(params.routing.transcriptsRef.current[bucket]?.messages).toContainEqual(
      expect.objectContaining({ requestId: "async-question", answer: "Read only" }),
    );
  });

  test("an answer arriving before React commits the question resolves its originating card", async () => {
    const bucket = bucketKey("project", "pinned-1");
    params.routing.engineToBucketRef.current.set("pinned-1", bucket);
    hook = await renderHook(() => {
      const [transcripts, dispatch] = useReducer(transcriptsReducer, {});
      params.services.dispatch = dispatch;
      params.routing.transcriptsRef.current = transcripts;
      useHostSubscriptions(params);
    });
    const question = approval("fast-answer", "__ask_user__");
    question.request.args = { ...question.request.args, asynchronous: true };
    await act(async () => {
      listeners.get("onApprovalRequest")!(question);
      // The request dispatch is queued and no card exists in transcriptsRef yet.
      expect(params.routing.transcriptsRef.current[bucket]).toBeUndefined();
      listeners.get("onApprovalResolved")!({
        requestId: question.requestId,
        sessionId: "pinned-1",
        approved: true,
        answer: "Read only",
      });
      await flushMicrotasks();
    });
    expect(params.routing.transcriptsRef.current[bucket]?.messages).toContainEqual(
      expect.objectContaining({ requestId: "fast-answer", answer: "Read only" }),
    );
    expect(
      params.routing.transcriptsRef.current[params.routing.activeBucketRef.current],
    ).toBeUndefined();
  });

  test("worker exit invalidates an in-flight snapshot and permits current worker request ids", async () => {
    const read = deferred<ApprovalRequestEnvelope[]>();
    readApprovals = () => read.promise;
    params.permissions.permissionOverrideForBucketRef.current = () => "bypass";
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
      await flushMicrotasks();
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

  test.each(["turn_complete", "error"])(
    "late stopped-run %s preserves successor busy and commits current output before idle",
    async (oldTerminal) => {
      const bucket = bucketKey("project", "pinned-4");
      params.routing.engineToBucketRef.current.set("engine", bucket);
      let initial = transcriptsReducer(
        {},
        { type: "user_message", bucket, text: "old", clientMessageId: "old-input" },
      );
      initial = transcriptsReducer(initial, {
        type: "stream_batch",
        bucket,
        events: [
          {
            type: "session_started",
            sessionId: "engine",
            promptTokens: 0,
            runId: "old-run",
            clientMessageId: "old-input",
          },
          {
            type: "stream_request_start",
            turnNumber: 1,
            messageId: "old-assistant",
            runId: "old-run",
            clientMessageId: "old-input",
          },
          {
            type: "usage_update",
            promptTokens: 108_800,
            singleTurnPromptTokens: 108_800,
            runId: "old-run",
            clientMessageId: "old-input",
          },
        ],
      });
      const idleMessages: string[][] = [];
      const setBusy = params.activity.setBusyForKey;
      params.activity.setBusyForKey = (key, value) => {
        if (!value)
          idleMessages.push(
            (params.routing.transcriptsRef.current[key]?.messages ?? []).map(
              (message) => message.kind,
            ),
          );
        setBusy(key, value);
      };
      hook = await renderHook(() => {
        const [transcripts, dispatch] = useReducer(transcriptsReducer, initial);
        params.services.dispatch = dispatch;
        params.routing.transcriptsRef.current = transcripts;
        useHostSubscriptions(params);
      });
      await act(async () => {
        params.services.dispatch({
          type: "turn_end",
          bucket,
          reason: "stopped",
          elapsedMs: 33_000,
        });
        params.services.dispatch({
          type: "user_message",
          bucket,
          text: "new",
          clientMessageId: "new-input",
        });
        setBusy(bucket, true);
        listeners.get("onStreamEvent")!({
          sessionId: "engine",
          event: {
            type: oldTerminal,
            reason: "aborted_streaming",
            error: "aborted",
            runId: "old-run",
            clientMessageId: "old-input",
          },
        });
        expect(busy.has(bucket)).toBe(true);
        expect(idleMessages).toEqual([]);
        await flushMicrotasks();
      });
      await act(async () => {
        for (const event of [
          { type: "session_started", sessionId: "engine", promptTokens: 0 },
          { type: "stream_request_start", turnNumber: 1, messageId: "new-assistant" },
          { type: "text_delta", text: "new partial" },
          { type: "usage_update", promptTokens: 20, singleTurnPromptTokens: 20 },
        ])
          listeners.get("onStreamEvent")!({
            sessionId: "engine",
            event: { ...event, runId: "new-run", clientMessageId: "new-input" },
          });
        params.routing.coalescersRef.current.get(bucket)!.flush();
        await flushMicrotasks();
        listeners.get("onStreamEvent")!({
          sessionId: "engine",
          event: {
            type: oldTerminal,
            reason: "aborted_streaming",
            error: "aborted",
            runId: "old-run",
            clientMessageId: "old-input",
          },
        });
        expect(busy.has(bucket)).toBe(true);
        expect(params.routing.transcriptsRef.current[bucket]!.streamingAssistantId).toBe(
          "new-assistant",
        );
        listeners.get("onStreamEvent")!({
          sessionId: "engine",
          event: {
            type: "turn_complete",
            reason: "completed",
            runId: "new-run",
            clientMessageId: "new-input",
          },
        });
        expect(busy.has(bucket)).toBe(false);
        expect(idleMessages).toHaveLength(1);
        expect(idleMessages[0]!.at(-1)).toBe("turn_usage");
      });
    },
  );

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
        { type: "text_delta", text: "The document is ready." },
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

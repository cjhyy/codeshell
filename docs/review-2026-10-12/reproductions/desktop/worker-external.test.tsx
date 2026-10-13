import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useReducer, type SetStateAction } from "react";
import {
  ensureMiniDom,
  flushMicrotasks,
  renderHook,
} from "../../../../packages/desktop/src/renderer/test-utils/renderHook";
import {
  loadProjects,
  saveProjects,
  type TrackedProject,
} from "../../../../packages/desktop/src/renderer/projects";
import {
  bucketKey,
  loadSessionIndex,
  NO_REPO_KEY,
  saveSessionIndex,
  type SessionIndex,
} from "../../../../packages/desktop/src/renderer/transcripts";
import {
  compactSidebarSessions,
  sortSidebarSessions,
} from "../../../../packages/desktop/src/renderer/sidebarSessionVisibility";
import {
  transcriptsReducer,
  type TranscriptsAction,
} from "../../../../packages/desktop/src/renderer/transcriptsReducer";
import { getSessionPersistence } from "../../../../packages/desktop/src/renderer/sessionPersistence";
import { useHostSubscriptions } from "../../../../packages/desktop/src/renderer/app/useHostSubscriptions";
import {
  INITIAL_STATE,
  type ApprovalState,
  type AskUserMessage,
} from "../../../../packages/desktop/src/renderer/types";
import type { ApprovalRequestEnvelope } from "../../../../packages/desktop/src/preload/types";
import type { PermissionMode } from "../../../../packages/desktop/src/renderer/chat/PermissionPill";

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

  test("CONFIRMED Core worker exit clears a still-running external runtime busy flag", async () => {
    const nativeBucket = bucketKey("project", "pinned-1");
    const externalBucket = bucketKey("project", "external-running");
    params.routing.engineToBucketRef.current.set("pinned-1", nativeBucket);
    params.routing.engineToBucketRef.current.set("external-running", externalBucket);
    busy = new Set([nativeBucket, externalBucket]);
    params.activity.setBusyKeys = (action) => {
      busy = typeof action === "function" ? action(busy) : action;
    };
    params.routing.runningBucketRef.current = externalBucket;
    hook = await renderHook(() => useHostSubscriptions(params));
    await act(async () => {
      listeners.get("onAgentLifecycle")!({ type: "exited", code: 1 });
      await flushMicrotasks();
    });
    expect(busy.has(nativeBucket)).toBe(false);
    expect(busy.has(externalBucket)).toBe(false);
    expect(params.routing.runningBucketRef.current).toBe(null);
  });
});

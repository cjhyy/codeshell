import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import { INITIAL_STATE } from "../types";
import { NO_REPO_KEY, saveSessionIndex } from "../transcripts";
import { useRunController } from "./useRunController";

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
let cleanup: (() => Promise<void>) | undefined;
let originalStorage: PropertyDescriptor | undefined;
let originalBridge: PropertyDescriptor | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
  if (originalBridge) Object.defineProperty(window, "codeshell", originalBridge);
});

test.each([false, true])(
  "old stopped run promise cannot clear the successor (reject=%s)",
  async (rejectOld) => {
    ensureMiniDom();
    originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    originalBridge = Object.getOwnPropertyDescriptor(window, "codeshell");
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
    const first = deferred();
    const second = deferred();
    let calls = 0;
    let busy = false;
    const actions: unknown[] = [];
    const noop = () => {};
    Object.assign(window, {
      codeshell: {
        log: noop,
        registerBrowserSessionBucket: noop,
        cancel: async () => {},
        run: () => (++calls === 1 ? first.promise : second.promise),
      },
    });
    const index = {
      sessions: [{ id: "session", title: "Session", createdAt: 1, updatedAt: 1 }],
      activeSessionId: "session",
    };
    saveSessionIndex(null, index);
    const bucket = `${NO_REPO_KEY}::session`;
    const params: Parameters<typeof useRunController>[0] = {
      shell: { t: ((key: string) => key) as any, lang: "en", toast: noop, setView: noop },
      session: {
        activeProjectId: null,
        activeSessionId: "session",
        activeBucket: bucket,
        projects: [],
        sessionIndices: { [NO_REPO_KEY]: index },
        setSessionIndices: noop,
        ensureActiveSession: () => "session",
      },
      preferences: {
        permissionOverrides: {},
        setPermissionOverrides: noop,
        defaultPermissionMode: null,
        goalOverrides: {},
        setGoalOverrides: noop,
        modelOverrides: {},
        setModelOverrides: noop,
        defaultActiveModelKey: null,
        quickChatDefaultModelKey: null,
      },
      runtime: {
        setBusyForKey: (_key, value) => {
          busy = value;
        },
        runningBucketRef: { current: null },
        engineToBucketRef: { current: new Map() },
        noRepoCwdRef: { current: "/tmp" },
        quickChatSessionsRef: { current: {} },
        queuedInputs: {},
        setQueuedInputs: noop,
        busy: false,
        busyKeys: new Set(),
        relayingBuckets: new Set(),
        setRelayingBuckets: noop,
        steeredIdsRef: { current: new Set() },
        injectedSteerIdsRef: { current: new Set() },
        downgradeRunQueueRef: { current: Promise.resolve() } as any,
        queuedSeqRef: { current: 0 },
        busySinceRef: { current: new Map() },
        compactingBucketsRef: { current: new Set() },
        setCompactingBuckets: noop,
      },
      transcript: {
        dispatch: (action) => {
          actions.push(action);
        },
        state: INITIAL_STATE,
      },
      approvals: {
        approval: null,
        approvalQueue: [],
        setApprovalQueue: noop,
        setApproval: noop,
        setApprovalHistory: noop,
        approvalBucketsRef: { current: new Map() },
      },
    };
    const hook = await renderHook(() => useRunController(params));
    cleanup = hook.unmount;
    let oldRun!: Promise<void>;
    let newRun!: Promise<void>;
    await act(async () => {
      oldRun = hook.result.current.send("old");
      await flushMicrotasks();
    });
    expect(calls).toBe(1);
    await act(async () => {
      hook.result.current.stop();
      newRun = hook.result.current.send("new");
      await flushMicrotasks();
    });
    expect(calls).toBe(2);
    expect(busy).toBe(true);
    const before = actions.length;
    await act(async () => {
      if (rejectOld) first.reject(new Error("late old failure"));
      else first.resolve({ reason: "aborted_streaming" });
      await oldRun;
      await flushMicrotasks();
    });
    expect(busy).toBe(true);
    expect(actions.length).toBe(before);
    await act(async () => {
      second.resolve({ reason: "completed" });
      await newRun;
      await flushMicrotasks();
    });
    expect(busy).toBe(false);
  },
);

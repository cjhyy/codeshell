import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import { INITIAL_STATE } from "../types";
import { NO_REPO_KEY, saveSessionIndex } from "../transcripts";
import { useRunController } from "./useRunController";

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

test("a queued follow-up is sent when its conversation finishes in the background", async () => {
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
  const runs: Array<{ task: string; sessionId?: string }> = [];
  const noop = () => {};
  Object.assign(window, {
    codeshell: {
      log: noop,
      registerBrowserSessionBucket: noop,
      cancel: async () => {},
      run: (task: string, opts: { sessionId?: string }) => {
        runs.push({ task, sessionId: opts?.sessionId });
        return new Promise(() => undefined);
      },
    },
  });
  const index = {
    sessions: [
      { id: "A", title: "A", createdAt: 1, updatedAt: 1 },
      { id: "B", title: "B", createdAt: 1, updatedAt: 1 },
    ],
    activeSessionId: "A",
  };
  saveSessionIndex(null, index);
  const A = `${NO_REPO_KEY}::A`;
  const B = `${NO_REPO_KEY}::B`;
  const busyKeys = new Set([A]);
  const params: Parameters<typeof useRunController>[0] = {
    shell: { t: ((key: string) => key) as any, lang: "en", toast: noop, setView: noop },
    session: {
      activeProjectId: null,
      // The user queued a follow-up in A while it ran, then switched to B.
      activeSessionId: "B",
      activeBucket: B,
      projects: [],
      sessionIndices: { [NO_REPO_KEY]: index },
      setSessionIndices: noop,
      ensureActiveSession: () => "A",
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
      setBusyForKey: (key, value) => {
        if (value) busyKeys.add(key);
        else busyKeys.delete(key);
      },
      runningBucketRef: { current: null },
      engineToBucketRef: { current: new Map() },
      noRepoCwdRef: { current: "/tmp" },
      quickChatSessionsRef: { current: {} },
      queuedInputs: { [A]: [{ id: "q1", clientMessageId: "m1", text: "then step two" }] },
      setQueuedInputs: (update) => {
        params.runtime.queuedInputs =
          typeof update === "function" ? update(params.runtime.queuedInputs) : update;
      },
      busy: false,
      busyKeys: new Set(busyKeys),
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
    transcript: { dispatch: noop, state: INITIAL_STATE, transcriptsRef: { current: {} } },
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
  expect(runs).toEqual([]);

  // A's run ends in the background.
  busyKeys.delete(A);
  params.runtime = { ...params.runtime, busyKeys: new Set(busyKeys) };
  await act(async () => {
    await hook.rerender();
    await flushMicrotasks();
  });
  expect(runs).toEqual([{ task: "then step two", sessionId: "A" }]);
  expect(params.runtime.queuedInputs[A] ?? []).toEqual([]);
  expect(busyKeys.has(A)).toBe(true);
  expect(busyKeys.has(B)).toBe(false);

  // Re-rendering does not send the same item twice.
  params.runtime = { ...params.runtime, busyKeys: new Set(busyKeys) };
  await act(async () => {
    await hook.rerender();
    await flushMicrotasks();
  });
  expect(runs).toHaveLength(1);
});

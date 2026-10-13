import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import {
  ensureMiniDom,
  flushMicrotasks,
  renderHook,
} from "../../../../packages/desktop/src/renderer/test-utils/renderHook";
import { INITIAL_STATE } from "../../../../packages/desktop/src/renderer/types";
import {
  NO_REPO_KEY,
  saveSessionIndex,
} from "../../../../packages/desktop/src/renderer/transcripts";
import { useRunController } from "../../../../packages/desktop/src/renderer/app/useRunController";

let cleanup;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});
function setup(reply: () => Promise<unknown>) {
  ensureMiniDom();
  const storage = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
  });
  const actions: any[] = [];
  const toasts: any[] = [];
  let busy = false;
  const noop = () => {};
  Object.assign(window, {
    codeshell: {
      log: noop,
      registerBrowserSessionBucket: noop,
      cancel: async () => {},
      run: reply,
    },
  });
  const index = {
    sessions: [
      { id: "A", title: "会话 A", createdAt: 1, updatedAt: 1 },
      { id: "B", title: "会话 B", createdAt: 1, updatedAt: 1 },
    ],
    activeSessionId: "A",
  };
  saveSessionIndex(null, index);
  const params: any = {
    shell: { t: (key) => key, lang: "zh", toast: (x) => toasts.push(x), setView: noop },
    session: {
      activeProjectId: null,
      activeSessionId: "A",
      activeBucket: `${NO_REPO_KEY}::A`,
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
      setBusyForKey: (_key, v) => {
        busy = v;
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
      downgradeRunQueueRef: { current: { tail: Promise.resolve() } },
      queuedSeqRef: { current: 0 },
      busySinceRef: { current: new Map() },
      compactingBucketsRef: { current: new Set() },
      setCompactingBuckets: noop,
    },
    transcript: { dispatch: (a) => actions.push(a), state: INITIAL_STATE },
    approvals: {
      approval: null,
      approvalQueue: [],
      setApprovalQueue: noop,
      setApproval: noop,
      setApprovalHistory: noop,
      approvalBucketsRef: { current: new Map() },
    },
  };
  return { params, actions, toasts, isBusy: () => busy };
}
test.each([
  [
    "image_error",
    {
      jsonrpc: "2.0",
      id: "request",
      result: {
        reason: "image_error",
        text: "ERROR: input attachment could not be read (session mismatch)",
      },
    },
  ],
  [
    "Main gate",
    {
      jsonrpc: "2.0",
      id: "request",
      error: { code: -32000, message: "配置正在更新，请稍后重试。" },
    },
  ],
  ["transport reject", new Error("worker exited before replying")],
])("CONFIRMED native send silently loses %s", async (_name, reply) => {
  const f = setup(async () => {
    if (reply instanceof Error) throw reply;
    return reply;
  });
  const h = await renderHook(() => useRunController(f.params));
  cleanup = h.unmount;
  await act(async () => {
    await h.result.current.send("帮我查看这个文件");
    await flushMicrotasks();
  });
  expect(f.isBusy()).toBe(false);
  expect(f.actions.map((a) => a.type)).toEqual(["user_message"]);
  expect(f.toasts).toEqual([]);
});
test("control: bare runtime error is visible", async () => {
  const f = setup(async () => ({ reason: "image_error", text: "ERROR: 无法读取附件" }));
  const h = await renderHook(() => useRunController(f.params));
  cleanup = h.unmount;
  await act(async () => {
    await h.result.current.send("查看附件");
    await flushMicrotasks();
  });
  expect(f.actions.map((a) => a.type)).toEqual(["user_message", "turn_end"]);
  expect(f.toasts[0].message).toBe("无法读取附件");
});
test("CONFIRMED queue is stranded when its conversation finishes in background", async () => {
  let calls = 0;
  const f = setup(async () => {
    calls++;
    return { result: { reason: "completed" } };
  });
  const A = `${NO_REPO_KEY}::A`,
    B = `${NO_REPO_KEY}::B`;
  f.params.runtime.queuedInputs = {
    [A]: [{ id: "q1", clientMessageId: "m1", text: "完成后继续第二步" }],
  };
  f.params.preferences.defaultActiveModelKey = "codex/gpt-5.6-sol";
  f.params.runtime.busy = true;
  f.params.runtime.busyKeys = new Set([A]);
  const h = await renderHook(() => useRunController(f.params));
  cleanup = h.unmount;
  expect(calls).toBe(0);
  // Select B while A runs, then A completes (the actual listener removes only A's busy key).
  f.params.session.activeSessionId = "B";
  f.params.session.activeBucket = B;
  f.params.runtime.busy = false;
  f.params.runtime.busyKeys = new Set();
  await h.rerender();
  await flushMicrotasks();
  expect(calls).toBe(0);
  expect(f.params.runtime.queuedInputs[A]).toHaveLength(1);
  expect(f.actions).toEqual([]);
});

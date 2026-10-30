import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import { INITIAL_STATE } from "../types";
import { NO_REPO_KEY, saveSessionIndex } from "../transcripts";
import { useRunController } from "./useRunController";
import { transcriptsReducer } from "../transcriptsReducer";

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

test("recovery holds pending launch and steer payloads until explicit fresh-ID confirmation", async () => {
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
  const actions: unknown[] = [];
  const toasts: unknown[] = [];
  const noop = () => {};
  const steer = deferred();
  const runs: Array<{ text: string; opts: any }> = [];
  Object.assign(window, {
    codeshell: {
      log: noop,
      registerBrowserSessionBucket: noop,
      markAttachmentsSent: async () => {},
      steer: () => steer.promise,
      run: (text: string, opts: unknown) => {
        runs.push({ text, opts });
        return new Promise(() => {});
      },
    },
  });
  const index = {
    sessions: [{ id: "session", title: "Session", createdAt: 1, updatedAt: 1 }],
    activeSessionId: "session",
  };
  saveSessionIndex(null, index);
  const bucket = `${NO_REPO_KEY}::session`;
  const params: Parameters<typeof useRunController>[0] = {
    shell: {
      t: ((key: string) => key) as any,
      lang: "en",
      toast: (value) => toasts.push(value),
      setView: noop,
    },
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
      setBusyForKey: noop,
      runningBucketRef: { current: null },
      engineToBucketRef: { current: new Map() },
      noRepoCwdRef: { current: "/tmp" },
      quickChatSessionsRef: { current: {} },
      queuedInputs: {},
      setQueuedInputs: (update) => {
        params.runtime.queuedInputs =
          typeof update === "function" ? update(params.runtime.queuedInputs) : update;
      },
      busy: true,
      busyKeys: new Set([bucket]),
      relayingBuckets: new Set(),
      setRelayingBuckets: noop,
      steeredIdsRef: { current: new Set() },
      injectedSteerIdsRef: { current: new Set() },
      downgradeRunQueueRef: { current: { tail: Promise.resolve() } } as any,
      queuedSeqRef: { current: 0 },
      busySinceRef: { current: new Map() },
      compactingBucketsRef: { current: new Set() },
      setCompactingBuckets: noop,
    },
    transcript: {
      transcriptsRef: { current: {} },
      dispatch: (action) => {
        actions.push(action);
        params.transcript.transcriptsRef.current = transcriptsReducer(
          params.transcript.transcriptsRef.current,
          action,
        );
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

  const attachments = [
    { kind: "file", path: "owned-fixture.txt", mime: "text/plain", size: 4 },
  ] as any;
  params.runtime.queuedInputs[bucket] = [
    { id: "old-steer", clientMessageId: "old-client", text: "queued text", attachments },
  ];
  const confirmed = {
    kind: "user" as const,
    id: "confirmed",
    text: "confirmed history",
    clientMessageId: "confirmed-client",
  };
  const cachedAttachment = {
    kind: "file" as const,
    path: "cached.txt",
    absPath: "/owned/cached.txt",
    sessionId: "session",
  };
  params.transcript.transcriptsRef.current[bucket] = {
    ...INITIAL_STATE,
    messages: [
      confirmed,
      {
        kind: "user",
        id: "cached",
        text: "cache-only text",
        clientMessageId: "cached-client",
        attachments: [cachedAttachment],
      },
    ],
  };
  const hook = await renderHook(() => useRunController(params));
  cleanup = hook.unmount;
  expect(params.runtime.steeredIdsRef.current.has("old-steer")).toBe(true);
  let launch!: Promise<void>;
  await act(async () => {
    launch = hook.result.current.send("pending text", {
      clientMessageId: "pending-client",
      attachments,
    });
    hook.result.current.beginOutputHistoryRecovery();
    steer.resolve({ result: { accepted: false } });
    await launch;
    await flushMicrotasks();
  });
  expect(runs).toEqual([]);
  expect(hook.result.current.heldRecoveryInputs.map((item) => item.text)).toEqual([
    "queued text",
    "pending text",
  ]);
  expect(
    hook.result.current.heldRecoveryInputs.every(
      (item) => item.attachments?.[0] === attachments[0],
    ),
  ).toBe(true);
  expect(params.runtime.queuedInputs[bucket]).toBeUndefined();
  expect(params.runtime.steeredIdsRef.current.size).toBe(0);
  await act(async () => {
    hook.result.current.confirmHeldRecoveryInputs(); // still blocked
    await hook.result.current.send("late captured send", { attachments });
    await flushMicrotasks();
  });
  expect(runs).toEqual([]);
  expect(hook.result.current.heldRecoveryInputs).toHaveLength(3);
  await act(async () => {
    params.runtime.busy = false;
    params.runtime.busyKeys = new Set();
    params.transcript.transcriptsRef.current[bucket] = { ...INITIAL_STATE, messages: [confirmed] };
    hook.result.current.finishOutputHistoryRecovery();
    await hook.rerender();
  });
  expect(runs).toEqual([]); // successful join does not release held input
  await act(async () => {
    hook.result.current.confirmHeldRecoveryInputs();
    hook.result.current.confirmHeldRecoveryInputs(); // double click cannot duplicate
    await hook.rerender();
    await flushMicrotasks();
  });
  expect(runs[0]?.text).toBe("queued text");
  expect(runs[0]?.opts.attachments).toEqual(attachments);
  expect(runs[0]?.opts.clientMessageId).not.toBe("old-client");
  expect(hook.result.current.heldRecoveryInputs).toEqual([
    expect.objectContaining({
      text: "cache-only text",
      manualReviewOnly: true,
      cachedAttachments: [cachedAttachment],
    }),
  ]);
  expect(
    hook.result.current.heldRecoveryInputs.some((item) => item.text === "confirmed history"),
  ).toBe(false);
  const allPayloads = [
    ...runs.map((run) => run.text),
    ...(params.runtime.queuedInputs[bucket] ?? []).map((item) => item.text),
  ];
  expect(allPayloads).toEqual(["queued text", "pending text", "late captured send"]);
});

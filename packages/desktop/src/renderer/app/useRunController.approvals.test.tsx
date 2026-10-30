import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement, StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ApprovalRequestEnvelope } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { INITIAL_STATE } from "../types";
import type { ApprovalHistoryEntry } from "./appUtils";
import { useRunController } from "./useRunController";

type Params = Parameters<typeof useRunController>[0];
function envelope(sessionId: string, requestId = sessionId): ApprovalRequestEnvelope {
  return {
    sessionId,
    requestId,
    request: { toolName: "Bash", args: { command: "git status" }, riskLevel: "low" },
  } as ApprovalRequestEnvelope;
}
function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function baseParams(toasts: unknown[]): Omit<Params, "approvals"> {
  const noop = () => {};
  return {
    shell: {
      t: ((key: string) => key) as any,
      lang: "en",
      toast: (value) => {
        toasts.push(value);
      },
      setView: noop,
    },
    session: {
      activeProjectId: null,
      activeSessionId: "session",
      activeBucket: "_no_repo_::session",
      projects: [],
      sessionIndices: {},
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
      noRepoCwdRef: { current: null },
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
    transcript: { dispatch: noop, state: INITIAL_STATE, transcriptsRef: { current: {} } },
  };
}
let restoreStorage: PropertyDescriptor | undefined;
let restoreBridge: PropertyDescriptor | undefined;
let cleanup: (() => Promise<void>) | undefined;
let calls: unknown[][];
let toasts: unknown[];
let mirrored: unknown[];
let deliver: (...args: unknown[]) => Promise<unknown>;
let mirror: (value: unknown) => Promise<unknown>;
beforeEach(() => {
  ensureMiniDom();
  restoreStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  restoreBridge = Object.getOwnPropertyDescriptor(window, "codeshell");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => {} },
  });
  calls = [];
  toasts = [];
  mirrored = [];
  deliver = async () => ({ result: {} });
  mirror = async () => undefined;
  Object.assign(window, {
    codeshell: {
      approve: (...args: unknown[]) => {
        calls.push(args);
        return deliver(...args);
      },
      log: () => {},
      mobileRemote: {
        notifyApprovalResolved: (value: unknown) => {
          mirrored.push(value);
          return mirror(value);
        },
      },
    },
  });
});
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  if (restoreStorage) Object.defineProperty(globalThis, "localStorage", restoreStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
  if (restoreBridge) Object.defineProperty(window, "codeshell", restoreBridge);
  else Reflect.deleteProperty(window, "codeshell");
});
async function mount(initial: ApprovalRequestEnvelope[]) {
  const base = baseParams(toasts);
  const hook = await renderStrictHook(() => {
    const [queue, setQueue] = useState(initial);
    const [approval, setApproval] = useState<ApprovalRequestEnvelope | null>(initial[0] ?? null);
    const [history, setHistory] = useState<ApprovalHistoryEntry[]>([]);
    const buckets = useRef(new Map(initial.map((entry) => [entry.requestId, "bucket"])));
    const controller = useRunController({
      ...base,
      approvals: {
        approval,
        approvalQueue: queue,
        setApprovalQueue: setQueue,
        setApproval,
        setApprovalHistory: setHistory,
        approvalBucketsRef: buckets,
      },
    });
    return { controller, queue, approval, history, setQueue, buckets };
  });
  cleanup = hook.unmount;
  return hook;
}

async function renderStrictHook<T>(useHook: () => T) {
  const result = { current: undefined as T | undefined };
  const root = createRoot(document.createElement("div"));
  function Host() {
    result.current = useHook();
    return null;
  }
  await act(async () => {
    root.render(createElement(StrictMode, null, createElement(Host)));
    await flushMicrotasks();
  });
  return {
    result: result as { current: T },
    unmount: async () => {
      await act(async () => {
        root.unmount();
        await flushMicrotasks();
      });
    },
  };
}

describe("accepted approval decisions", () => {
  test("keeps failed requests pending, prevents duplicate deliveries, and permits a retry", async () => {
    const env = envelope("session");
    env.source = "external-runtime";
    const first = deferred();
    deliver = () => first.promise;
    const hook = await mount([env]);
    let submission!: Promise<void>;
    await act(async () => {
      submission = hook.result.current.controller.decideEnvelope(
        env,
        "approve",
        undefined,
        "session",
      );
      expect(
        hook.result.current.controller.decideEnvelope(env, "approve", undefined, "session"),
      ).toBe(submission);
      await flushMicrotasks();
    });
    expect(calls).toHaveLength(1);
    expect(hook.result.current.queue).toEqual([env]);
    expect(hook.result.current.history).toEqual([]);
    expect(mirrored).toEqual([]);
    await act(async () => {
      first.reject(new Error("offline"));
      await submission.catch(() => {});
      await flushMicrotasks();
    });
    expect(hook.result.current.queue).toEqual([env]);
    expect(hook.result.current.approval).toBe(env);
    expect(hook.result.current.history).toEqual([]);
    expect(toasts).toHaveLength(1);
    deliver = async () => ({ result: {} });
    await act(async () => {
      await hook.result.current.controller.decideEnvelope(env, "approve", undefined, "session");
      await flushMicrotasks();
    });
    expect(calls).toHaveLength(2);
    expect(hook.result.current.queue).toEqual([]);
    expect(hook.result.current.history).toHaveLength(1);
    expect(mirrored).toEqual([
      { requestId: env.requestId, sessionId: env.sessionId, approved: true },
    ]);
    expect(calls[1].slice(0, 3)).toEqual(["session", "session", "approve"]);
    expect(calls[1][5]).toBe("session");
  });

  test("treats RPC error envelopes as failures and rejects a conflicting concurrent choice", async () => {
    const env = envelope("session");
    const pending = deferred();
    deliver = () => pending.promise;
    const hook = await mount([env]);
    let submission!: Promise<void>;
    await act(async () => {
      submission = hook.result.current.controller.decideEnvelope(env, "approve");
      await expect(hook.result.current.controller.decideEnvelope(env, "deny")).rejects.toThrow(
        "activityApprovals.submitting",
      );
      await flushMicrotasks();
      pending.resolve({ error: { code: -1, message: "session closed" } });
      await expect(submission).rejects.toThrow("session closed");
      await flushMicrotasks();
    });
    expect(calls).toHaveLength(1);
    expect(hook.result.current.queue).toEqual([env]);
    expect(hook.result.current.history).toEqual([]);
    expect(mirrored).toEqual([]);
  });

  test("out-of-order acknowledgements preserve newly arrived approvals and reused IDs in other sessions", async () => {
    const first = envelope("first", "shared-id");
    const second = envelope("second", "shared-id");
    const newest = envelope("newest");
    const firstResponse = deferred();
    const secondResponse = deferred();
    deliver = (sessionId) =>
      sessionId === "first" ? firstResponse.promise : secondResponse.promise;
    const hook = await mount([first, second]);
    let a!: Promise<void>;
    let b!: Promise<void>;
    await act(async () => {
      a = hook.result.current.controller.decideEnvelope(first, "approve");
      b = hook.result.current.controller.decideEnvelope(
        second,
        "deny",
        "wrong target",
        "project",
        "file",
      );
      hook.result.current.setQueue((queue) => [...queue, newest]);
      await flushMicrotasks();
    });
    await act(async () => {
      firstResponse.resolve({ result: {} });
      await a;
      await flushMicrotasks();
    });
    expect(hook.result.current.queue).toEqual([second, newest]);
    expect(hook.result.current.approval).toBe(second);
    expect(hook.result.current.buckets.current.has("shared-id")).toBe(true);
    await act(async () => {
      secondResponse.resolve({ result: {} });
      await b;
      await flushMicrotasks();
    });
    expect(hook.result.current.queue).toEqual([newest]);
    expect(hook.result.current.approval).toBe(newest);
    expect(hook.result.current.history.map((entry) => entry.decision)).toEqual(["approve", "deny"]);
    expect(calls[1].slice(3)).toEqual(["wrong target", undefined, undefined, undefined]);
  });

  test("a failed mobile notification cannot undo or reject an accepted decision", async () => {
    const env = envelope("session");
    env.source = "external-runtime";
    mirror = async () => {
      throw new Error("mobile offline");
    };
    const hook = await mount([env]);
    await act(async () => {
      await hook.result.current.controller.decideEnvelope(env, "approve");
      await flushMicrotasks();
    });
    expect(hook.result.current.history).toHaveLength(1);
    expect(hook.result.current.queue).toEqual([]);
    expect(toasts).toEqual([]);
  });

  test("native decisions rely on Core's authoritative resolution instead of a partial mirror", async () => {
    const env = envelope("session");
    const hook = await mount([env]);
    await act(async () => {
      await hook.result.current.controller.decideEnvelope(env, "approve");
      await flushMicrotasks();
    });
    expect(hook.result.current.history).toHaveLength(1);
    expect(hook.result.current.queue).toEqual([]);
    expect(mirrored).toEqual([]);
  });
});

test("recovery retires queued and in-flight approval acknowledgements without replay", async () => {
  const early = envelope("session", "queued-old");
  const late = envelope("session", "in-flight-old");
  const hook = await mount([early, late]);
  const response = deferred();
  deliver = () => response.promise;
  let inFlight!: Promise<void>;
  await act(async () => {
    inFlight = hook.result.current!.controller.decideEnvelope(late, "approve");
    await flushMicrotasks();
  });
  expect(calls).toHaveLength(1);
  await act(async () => {
    const queued = hook.result.current!.controller.decideEnvelope(early, "approve");
    hook.result.current!.controller.beginOutputHistoryRecovery("bucket");
    await queued;
    response.resolve({ result: {} });
    await inFlight;
  });
  expect(calls).toHaveLength(1);
  expect(hook.result.current!.queue).toEqual([]);
  expect(hook.result.current!.history).toEqual([]);
  expect(mirrored).toEqual([]);
  await act(async () => {
    hook.result.current!.controller.finishOutputHistoryRecovery("bucket");
    await hook.result.current!.controller.decideEnvelope(early, "approve");
  });
  expect(calls).toHaveLength(1);
  expect(toasts).toEqual([]);
});

test("recovery retirement is scoped to the session even when approval IDs are reused", async () => {
  const old = envelope("session", "reused");
  const other = envelope("other-session", "reused");
  const hook = await mount([old, other]);
  await act(async () => {
    const queued = hook.result.current!.controller.decideEnvelope(old, "approve");
    hook.result.current!.controller.beginOutputHistoryRecovery("_no_repo_::session");
    await queued;
  });
  expect(calls).toEqual([]);
  expect(hook.result.current!.queue).toEqual([other]);
  await act(async () => {
    await hook.result.current!.controller.decideEnvelope(other, "approve");
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.[0]).toBe("other-session");
});

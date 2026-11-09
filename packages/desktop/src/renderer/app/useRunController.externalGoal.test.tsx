import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import { INITIAL_STATE, type ActiveGoal } from "../types";
import { NO_REPO_KEY, saveSessionIndex } from "../transcripts";
import { useRunController } from "./useRunController";
import { transcriptsReducer } from "../transcriptsReducer";

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

const A = `${NO_REPO_KEY}::A`;
const runningGoal: ActiveGoal = {
  objective: "持续推进",
  goalId: "g1",
  revision: 1,
  round: 2,
  paused: false,
};

/** One busy external-runtime conversation, optionally with a queued follow-up. */
async function mountBusyExternal(goal: ActiveGoal | null, queued: boolean) {
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
  const yields: string[] = [];
  const cancels: Array<{ sessionId?: string; options?: { keepGoal?: boolean } }> = [];
  const noop = () => {};
  Object.assign(window, {
    codeshell: {
      log: noop,
      registerBrowserSessionBucket: noop,
      cancel: async (sessionId?: string, options?: { keepGoal?: boolean }) => {
        cancels.push({ sessionId, options });
      },
      externalRuntime: {
        yieldGoal: async (sessionId: string) => {
          yields.push(sessionId);
          return true;
        },
      },
    },
  });
  const index = {
    sessions: [{ id: "A", title: "A", createdAt: 1, updatedAt: 1 }],
    activeSessionId: "A",
  };
  saveSessionIndex(null, index);
  const params: Parameters<typeof useRunController>[0] = {
    shell: { t: ((key: string) => key) as any, lang: "en", toast: noop, setView: noop },
    session: {
      activeProjectId: null,
      activeSessionId: "A",
      activeBucket: A,
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
      modelOverrides: { [A]: "codex/gpt-test" },
      setModelOverrides: noop,
      defaultActiveModelKey: null,
      quickChatDefaultModelKey: null,
    },
    runtime: {
      setBusyForKey: noop,
      runningBucketRef: { current: A },
      engineToBucketRef: { current: new Map() },
      noRepoCwdRef: { current: "/tmp" },
      quickChatSessionsRef: { current: {} },
      queuedInputs: queued ? { [A]: [{ id: "q1", clientMessageId: "m1", text: "先做求职" }] } : {},
      setQueuedInputs: (update) => {
        params.runtime.queuedInputs =
          typeof update === "function" ? update(params.runtime.queuedInputs) : update;
      },
      busy: true,
      busyKeys: new Set([A]),
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
      dispatch: noop,
      state: { ...INITIAL_STATE, activeGoal: goal },
      transcriptsRef: { current: {} },
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
  await act(async () => {
    await flushMicrotasks();
  });
  return { hook, params, yields, cancels };
}

test("a message queued behind a running external Goal asks it to yield once", async () => {
  const { hook, yields } = await mountBusyExternal(runningGoal, true);
  expect(yields).toEqual(["A"]);
  await act(async () => {
    await hook.rerender();
    await flushMicrotasks();
  });
  expect(yields).toEqual(["A"]);
});

test("a paused Goal or plain turn is not asked to yield", async () => {
  const paused = await mountBusyExternal({ ...runningGoal, paused: true }, true);
  expect(paused.yields).toEqual([]);
  await cleanup?.();
  cleanup = undefined;
  const plain = await mountBusyExternal(null, true);
  expect(plain.yields).toEqual([]);
});

test("interrupt-and-send keeps the Goal while Stop does not", async () => {
  const { hook, cancels } = await mountBusyExternal(runningGoal, false);
  await act(async () => {
    hook.result.current.forceSend("换个方向");
    await flushMicrotasks();
  });
  await act(async () => {
    hook.result.current.stop();
    await flushMicrotasks();
  });
  expect(cancels).toEqual([
    { sessionId: "A", options: { keepGoal: true } },
    { sessionId: "A", options: undefined },
  ]);
});

test.each(["native", "external"] as const)(
  "a goal reply inherits its objective and preserves the next-message goal toggle (%s)",
  async (runtime) => {
    const { hook, params } = await mountBusyExternal(
      { ...runningGoal, waitingForUser: "这处可以接受吗？" },
      false,
    );
    const requests: Array<Record<string, unknown>> = [];
    const goalUpdates: unknown[] = [];
    params.preferences.goalOverrides = { [A]: true };
    params.preferences.setGoalOverrides = (update) => goalUpdates.push(update);
    params.runtime.busy = false;
    params.runtime.busyKeys = new Set();
    if (runtime === "native") {
      params.preferences.modelOverrides = {};
      window.codeshell.run = (async (_text, opts) => {
        requests.push(opts!);
        return {};
      }) as typeof window.codeshell.run;
    } else {
      window.codeshell.externalRuntime!.start = async () => ({ ok: true }) as never;
      window.codeshell.externalRuntime!.send = async (request) => {
        requests.push(request);
        return { ok: true } as never;
      };
    }
    await act(async () => {
      await hook.rerender();
    });
    await act(async () => {
      await hook.result.current.send("这处可接受", { bucket: A, continueGoal: true });
      await flushMicrotasks();
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.goal).toBeUndefined();
    expect(requests[0]!.disableGoal).toBeUndefined();
    expect(goalUpdates).toEqual([]);

    await act(async () => {
      await hook.result.current.send("普通输入框准备的下一个目标", { bucket: A });
      await flushMicrotasks();
    });
    expect(requests[1]!.goal).toBe("普通输入框准备的下一个目标");
    expect(goalUpdates).toHaveLength(1);
  },
);

test.each([
  "rejected",
  "early-error",
  "changed-goal",
  "new-question",
  "started",
  "newer-launch",
] as const)(
  "a failed goal reply restores only the unanswered question of an unstarted current launch (%s)",
  async (outcome) => {
    const goal = { ...runningGoal, waitingForUser: "这处可以接受吗？", activeMs: 5_000 };
    const { hook, params } = await mountBusyExternal(goal, false);
    params.preferences.modelOverrides = {};
    params.runtime.busy = false;
    params.runtime.busyKeys = new Set();
    params.transcript.transcriptsRef.current = { [A]: { ...INITIAL_STATE, activeGoal: goal } };
    params.transcript.dispatch = (action) => {
      params.transcript.transcriptsRef.current = transcriptsReducer(
        params.transcript.transcriptsRef.current,
        action,
      );
    };
    let fail!: () => void;
    let clientMessageId = "";
    let calls = 0;
    window.codeshell.run = (async (_text, opts) => {
      if (++calls > 1) return {};
      clientMessageId = opts!.clientMessageId!;
      return new Promise((resolve, reject) => {
        fail = () =>
          outcome === "early-error"
            ? resolve({ reason: "model_error", text: "cannot start" })
            : reject(new Error("cannot start"));
      });
    }) as typeof window.codeshell.run;
    await act(async () => {
      await hook.rerender();
    });
    let result!: Promise<"resolved" | "rejected">;
    await act(async () => {
      result = hook.result.current.send("这处可接受", { bucket: A, continueGoal: true }).then(
        () => "resolved" as const,
        () => "rejected" as const,
      );
      await flushMicrotasks();
    });
    expect(params.transcript.transcriptsRef.current[A]!.activeGoal?.waitingForUser).toBeUndefined();
    if (outcome === "changed-goal") {
      params.transcript.dispatch({
        type: "stream",
        bucket: A,
        event: {
          type: "goal_updated",
          goalId: "g1",
          revision: 2,
          objective: "新的目标",
          paused: false,
        },
      });
    } else if (outcome === "new-question") {
      params.transcript.dispatch({
        type: "stream",
        bucket: A,
        event: {
          type: "goal_progress",
          goalId: "g1",
          revision: 1,
          status: "not_met",
          round: 3,
          waitingForUser: "新的问题",
        },
      });
    } else if (outcome === "started") {
      params.transcript.dispatch({
        type: "stream",
        bucket: A,
        event: {
          type: "session_started",
          sessionId: "A",
          promptTokens: 0,
          runId: "reply-run",
          clientMessageId,
        },
      });
    } else if (outcome === "newer-launch") {
      await act(async () => {
        await hook.result.current.send("新的消息", { bucket: A });
      });
    }
    await act(async () => {
      fail();
      await result;
      await flushMicrotasks();
    });
    const current = params.transcript.transcriptsRef.current[A]!.activeGoal!;
    if (outcome === "rejected" || outcome === "early-error") {
      expect(await result).toBe("rejected");
      expect(current.waitingForUser).toBe(goal.waitingForUser);
      expect(current.activeMs).toBe(5_000);
      expect(current.clockSinceMs).toBeUndefined();
    } else {
      expect(await result).toBe("resolved");
      expect(current.waitingForUser).toBe(outcome === "new-question" ? "新的问题" : undefined);
      if (outcome === "changed-goal") expect(current.revision).toBe(2);
    }
  },
);

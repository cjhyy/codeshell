import { describe, expect, test } from "bun:test";
import { act } from "react";
import type {
  OutputHistoryRecoveryPlan,
  OutputHistoryRecoveryResult,
} from "@cjhyy/code-shell-core";
import { renderHook } from "../test-utils/renderHook.js";
import {
  useOutputHistoryRecovery,
  type OutputHistoryRecoveryProps,
} from "./OutputHistoryRecovery.js";

const ready: OutputHistoryRecoveryPlan = {
  status: "ready",
  sessionId: "session-1",
  planId: "reviewed-plan",
  historicalGap: true,
  notice: "historical_notifications_incomplete",
  comparison: { turns: 3, userInputs: 2, toolCalls: 1, toolResults: 1 },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function props(overrides: Partial<OutputHistoryRecoveryProps> = {}): OutputHistoryRecoveryProps {
  return {
    sessionId: "session-1",
    identity: "workspace:connection:session-1",
    failed: true,
    plan: async () => ready,
    apply: async () => ({ status: "applied", sessionId: "session-1", historicalGap: true }),
    onApplied() {},
    ...overrides,
  };
}
describe("explicit output history recovery review", () => {
  test("only explicit confirmation applies the displayed plan once", async () => {
    const applied = deferred<OutputHistoryRecoveryResult>();
    const calls: unknown[] = [];
    let completes = 0;
    const hook = await renderHook(() =>
      useOutputHistoryRecovery(
        props({
          apply: (id, acceptance) => {
            calls.push({ id, acceptance });
            return applied.promise;
          },
          onApplied: () => {
            completes++;
          },
        }),
      ),
    );
    expect(calls).toEqual([]);
    await act(async () => {
      await hook.result.current.check();
    });
    expect(hook.result.current.review.status).toBe("ready");
    expect(calls).toEqual([]);
    await act(async () => {
      void hook.result.current.confirm();
      void hook.result.current.confirm();
    });
    expect(calls).toEqual([
      { id: "session-1", acceptance: { planId: "reviewed-plan", acceptHistoricalGap: true } },
    ]);
    await act(async () => {
      applied.resolve({ status: "applied", sessionId: "session-1", historicalGap: true });
    });
    expect(completes).toBe(1);
    await hook.unmount();
  });
  test("navigation invalidates a pending review and cannot approve another session", async () => {
    const plan = deferred<OutputHistoryRecoveryPlan>();
    let current = props({ plan: () => plan.promise });
    let calls = 0;
    current.apply = async () => {
      calls++;
      return { status: "applied", sessionId: "session-1", historicalGap: true };
    };
    const hook = await renderHook(() => useOutputHistoryRecovery(current));
    await act(async () => {
      void hook.result.current.check();
    });
    current = { ...current, identity: "workspace:connection:session-2", sessionId: "session-2" };
    await hook.rerender();
    await act(async () => {
      plan.resolve(ready);
    });
    expect(hook.result.current.review.status).toBe("idle");
    await act(async () => {
      await hook.result.current.confirm();
    });
    expect(calls).toBe(0);
    await hook.unmount();
  });
  test("unprovable and stale results remain explicit failures", async () => {
    const hook = await renderHook(() =>
      useOutputHistoryRecovery(
        props({
          apply: async () => ({ status: "stale", sessionId: "session-1", reason: "stale" }),
        }),
      ),
    );
    await act(async () => {
      await hook.result.current.check();
    });
    await act(async () => {
      await hook.result.current.confirm();
    });
    expect(hook.result.current.review).toEqual({ status: "blocked", reason: "stale" });
    await hook.unmount();
  });
  test("request timeout leaves a retryable error and ignores late success", async () => {
    const plan = deferred<OutputHistoryRecoveryPlan>();
    const hook = await renderHook(() =>
      useOutputHistoryRecovery(props({ plan: () => plan.promise, timeoutMs: 5 })),
    );
    await act(async () => {
      await hook.result.current.check();
    });
    expect(hook.result.current.review).toEqual({ status: "blocked", reason: "unavailable" });
    await act(async () => {
      plan.resolve(ready);
    });
    expect(hook.result.current.review.status).toBe("blocked");
    await hook.unmount();
  });
  test("disabled actions never send and cancellation retires the reviewed plan", async () => {
    let current = props();
    const hook = await renderHook(() => useOutputHistoryRecovery(current));
    await act(async () => {
      await hook.result.current.check();
    });
    await act(async () => {
      hook.result.current.cancel();
    });
    current = { ...current, disabled: true };
    await hook.rerender();
    await act(async () => {
      await hook.result.current.check();
      await hook.result.current.confirm();
    });
    expect(hook.result.current.review.status).toBe("idle");
    await hook.unmount();
  });
});

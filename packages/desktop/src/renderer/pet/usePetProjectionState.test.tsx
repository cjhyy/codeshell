import { describe, expect, test } from "bun:test";
import type { PetProjectionEvent, PetProjectionSnapshot } from "../../preload/types";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { usePetProjectionState } from "./usePetProjectionState";

function snapshot(version: number): PetProjectionSnapshot {
  return {
    version,
    generation: 1,
    workerState: "active",
    sessions: [],
    pending: [],
    observedAt: version,
  };
}

describe("usePetProjectionState", () => {
  test("keeps a resolved decision removed when its event races a recovery snapshot", async () => {
    ensureMiniDom();
    let listener: ((event: PetProjectionEvent) => void) | undefined;
    let resolveRecovery!: (value: PetProjectionSnapshot) => void;
    const pending = {
      agentSessionId: "work",
      requestId: "question",
      kind: "ask_user" as const,
      title: "需要用户回答",
      createdAt: 1,
      status: "pending" as const,
    };
    let calls = 0;
    const api = {
      getSnapshot: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve({ ...snapshot(1), pending: [pending] })
          : new Promise<PetProjectionSnapshot>((resolve) => {
              resolveRecovery = resolve;
            });
      },
      onProjectionEvent: (next: (event: PetProjectionEvent) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    };
    let latest: ReturnType<typeof usePetProjectionState> | undefined;
    function Consumer() {
      latest = usePetProjectionState(api);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => {
        root.render(<Consumer />);
        await flushMicrotasks();
      });
      await act(async () => {
        listener?.({ kind: "reset", version: 2, generation: 1, observedAt: 2 });
        // Both events may arrive before React starts the recovery effect.
        listener?.({
          kind: "pending-remove",
          version: 3,
          generation: 1,
          observedAt: 3,
          sessionId: "work",
          requestId: "question",
        });
        await flushMicrotasks();
      });
      expect(calls).toBe(2);
      await act(async () => {
        resolveRecovery({ ...snapshot(2), pending: [pending] });
        await flushMicrotasks();
      });
      expect(latest?.projection?.pending).toEqual([]);
      expect(latest).toMatchObject({
        status: "ready",
        needsSnapshot: false,
        projection: { version: 3 },
      });
    } finally {
      await act(async () => root.unmount());
    }
  });

  test("retries initial and later reconciliation failures until recovery, then stops", async () => {
    ensureMiniDom();
    let listener: ((event: PetProjectionEvent) => void) | undefined;
    let calls = 0;
    const responses: Array<PetProjectionSnapshot | Error> = [
      new Error("initial-1"),
      new Error("initial-2"),
      snapshot(3),
      new Error("reconcile-1"),
      new Error("reconcile-2"),
      snapshot(5),
    ];
    const api = {
      getSnapshot: async () => {
        calls += 1;
        const response = responses.shift();
        if (response instanceof Error) throw response;
        if (!response) throw new Error("unexpected extra retry");
        return response;
      },
      onProjectionEvent: (next: (event: PetProjectionEvent) => void) => {
        listener = next;
        return () => {
          if (listener === next) listener = undefined;
        };
      },
    };
    const immediateRetry = () => 0;
    let latest: ReturnType<typeof usePetProjectionState> | undefined;
    function Consumer() {
      latest = usePetProjectionState(api, immediateRetry);
      return null;
    }
    const root = createRoot(document.createElement("div"));

    await act(async () => {
      root.render(<Consumer />);
      await flushMicrotasks();
    });
    for (let index = 0; index < 3; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await flushMicrotasks();
      });
    }
    expect(calls).toBe(3);
    expect(latest).toMatchObject({ status: "ready", projection: { version: 3 } });

    await act(async () => {
      listener?.({
        kind: "worker-state",
        version: 5,
        generation: 1,
        observedAt: 5,
        state: "active",
      });
      await flushMicrotasks();
    });
    for (let index = 0; index < 3; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await flushMicrotasks();
      });
    }
    expect(calls).toBe(6);
    expect(latest).toMatchObject({
      status: "ready",
      needsSnapshot: false,
      projection: { version: 5 },
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toBe(6);
    await act(async () => root.unmount());
    expect(listener).toBeUndefined();
  });

  test("requests a newer baseline when a recovery response predates a buffered reset", async () => {
    ensureMiniDom();
    let listener: ((event: PetProjectionEvent) => void) | undefined;
    let calls = 0;
    const api = {
      getSnapshot: async () => snapshot(++calls),
      onProjectionEvent: (next: (event: PetProjectionEvent) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    };
    let latest: ReturnType<typeof usePetProjectionState> | undefined;
    function Consumer() {
      latest = usePetProjectionState(api);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => {
        root.render(<Consumer />);
        await flushMicrotasks();
      });
      await act(async () => {
        listener?.({ kind: "reset", generation: 1, version: 3, observedAt: 3 });
        await flushMicrotasks();
      });
      expect(calls).toBe(3);
      expect(latest).toMatchObject({
        status: "ready",
        needsSnapshot: false,
        projection: { version: 3 },
      });
    } finally {
      await act(async () => root.unmount());
    }
  });
});

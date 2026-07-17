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
});

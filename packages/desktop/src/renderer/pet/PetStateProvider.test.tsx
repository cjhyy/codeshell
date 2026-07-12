import { describe, expect, test } from "bun:test";
import type { PetApi, PetProjectionEvent, PetProjectionSnapshot } from "../../preload/types";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { PetStateProvider, usePetState } from "./PetStateProvider";

function snapshot(version = 0): PetProjectionSnapshot {
  return {
    version,
    generation: 0,
    workerState: "reclaimed",
    sessions: [],
    pending: [],
    observedAt: version + 1,
  };
}

describe("PetStateProvider", () => {
  test("keeps one effective listener in StrictMode and cleans it up", async () => {
    ensureMiniDom();
    const listeners = new Set<(event: PetProjectionEvent) => void>();
    let maximumListeners = 0;
    let snapshotCalls = 0;
    const api: PetApi = {
      getSnapshot: async () => {
        snapshotCalls += 1;
        return snapshot();
      },
      onProjectionEvent: (listener) => {
        listeners.add(listener);
        maximumListeners = Math.max(maximumListeners, listeners.size);
        return () => listeners.delete(listener);
      },
      openSession: async () => ({ status: "not-found" }),
    };
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <React.StrictMode>
          <PetStateProvider api={api}>
            <span>shell</span>
          </PetStateProvider>
        </React.StrictMode>,
      );
      await flushMicrotasks();
    });

    expect(maximumListeners).toBe(1);
    expect(listeners.size).toBe(1);
    expect(snapshotCalls).toBeGreaterThanOrEqual(1);
    await act(async () => root.unmount());
    expect(listeners.size).toBe(0);
  });

  test("stays mounted across Settings content and keeps draft while receiving projection updates", async () => {
    ensureMiniDom();
    const listeners = new Set<(event: PetProjectionEvent) => void>();
    const api: PetApi = {
      getSnapshot: async () => snapshot(),
      onProjectionEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      openSession: async () => ({ status: "not-found" }),
    };
    let latest: ReturnType<typeof usePetState> | undefined;
    function Consumer({ page }: { page: "chat" | "settings_page" }) {
      latest = usePetState();
      return <span>{page}</span>;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = async (page: "chat" | "settings_page") => {
      await act(async () => {
        root.render(
          <PetStateProvider api={api}>
            <Consumer page={page} />
          </PetStateProvider>,
        );
        await flushMicrotasks();
      });
    };
    await render("chat");
    await act(async () => latest?.dispatch({ type: "set-chat-draft", draft: "kept" }));
    await render("settings_page");
    await act(async () => {
      for (const listener of listeners) {
        listener({
          kind: "worker-state",
          generation: 0,
          version: 1,
          observedAt: 2,
          state: "active",
        });
      }
      await flushMicrotasks();
    });

    expect(listeners.size).toBe(1);
    expect(latest?.state.chatDraft).toBe("kept");
    expect(latest?.state.projection?.workerState).toBe("active");
    await act(async () => root.unmount());
  });
});

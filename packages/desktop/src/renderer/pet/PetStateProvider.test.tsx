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
  test("does not let a stale attention snapshot overwrite the live PendingDecisionIndex count", async () => {
    ensureMiniDom();
    let resolveAttentionSnapshot:
      | ((snapshot: { surfaceablePendingCount: number }) => void)
      | undefined;
    let attentionListener: Parameters<PetApi["onAttentionEvent"]>[0] | undefined;
    const api: PetApi = {
      getSnapshot: async () => snapshot(),
      onProjectionEvent: () => () => {},
      openSession: async () => ({ status: "not-found" }),
      dispatch: async () => ({ ok: false, code: "invalid-command" }),
      getAttentionSnapshot: () =>
        new Promise((resolve) => {
          resolveAttentionSnapshot = resolve;
        }),
      onAttentionEvent: (listener) => {
        attentionListener = listener;
        return () => {
          if (attentionListener === listener) attentionListener = undefined;
        };
      },
      setActiveSession: async () => ({ ok: true }),
      markAttentionReceipt: async () => ({ ok: true }),
    };
    let latest: ReturnType<typeof usePetState> | undefined;
    function Consumer() {
      latest = usePetState();
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => {
      root.render(
        <PetStateProvider api={api}>
          <Consumer />
        </PetStateProvider>,
      );
      await flushMicrotasks();
    });

    await act(async () => {
      attentionListener?.({ kind: "count", surfaceablePendingCount: 3 });
      resolveAttentionSnapshot?.({ surfaceablePendingCount: 1 });
      await flushMicrotasks();
    });

    expect(latest?.surfaceablePendingCount).toBe(3);
    await act(async () => root.unmount());
  });

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
      dispatch: async () => ({ ok: false, code: "invalid-command" }),
      getAttentionSnapshot: async () => ({ surfaceablePendingCount: 0 }),
      onAttentionEvent: () => () => {},
      setActiveSession: async () => ({ ok: true }),
      markAttentionReceipt: async () => ({ ok: true }),
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

  test("keeps retrying an early IPC startup race until the durable snapshot arrives", async () => {
    ensureMiniDom();
    let snapshotCalls = 0;
    const api: PetApi = {
      getSnapshot: async () => {
        snapshotCalls += 1;
        if (snapshotCalls < 3) throw new Error("handler not ready");
        return snapshot(7);
      },
      onProjectionEvent: () => () => {},
      openSession: async () => ({ status: "not-found" }),
      dispatch: async () => ({ ok: false, code: "invalid-command" }),
      getAttentionSnapshot: async () => ({ surfaceablePendingCount: 0 }),
      onAttentionEvent: () => () => {},
      setActiveSession: async () => ({ ok: true }),
      markAttentionReceipt: async () => ({ ok: true }),
    };
    let latest: ReturnType<typeof usePetState> | undefined;
    function Consumer() {
      latest = usePetState();
      return null;
    }
    const root = createRoot(document.createElement("div"));

    await act(async () => {
      root.render(
        <PetStateProvider api={api} snapshotRetryDelay={() => 0}>
          <Consumer />
        </PetStateProvider>,
      );
      await flushMicrotasks();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await flushMicrotasks();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await flushMicrotasks();
    });

    expect(snapshotCalls).toBe(3);
    expect(latest?.state).toMatchObject({ status: "ready", needsSnapshot: false });
    expect(latest?.state.projection?.version).toBe(7);
    await act(async () => root.unmount());
  });

  test("recovers Pet chat identity and attention state from the same IPC startup race", async () => {
    ensureMiniDom();
    let dispatchCalls = 0;
    let attentionCalls = 0;
    const api: PetApi = {
      getSnapshot: async () => snapshot(),
      onProjectionEvent: () => () => {},
      openSession: async () => ({ status: "not-found" }),
      dispatch: async () => {
        dispatchCalls += 1;
        if (dispatchCalls === 1) throw new Error("handler not ready");
        return {
          ok: true,
          type: "global_status",
          version: 0,
          generation: 0,
          observedAt: 1,
          workerState: "reclaimed",
          petSessionId: "pet-recovered",
          runningCount: 0,
          queuedCount: 0,
          pendingCount: 4,
          sessions: [],
        };
      },
      getAttentionSnapshot: async () => {
        attentionCalls += 1;
        if (attentionCalls === 1) throw new Error("handler not ready");
        return { surfaceablePendingCount: 4 };
      },
      onAttentionEvent: () => () => {},
      setActiveSession: async () => ({ ok: true }),
      markAttentionReceipt: async () => ({ ok: true }),
    };
    let latest: ReturnType<typeof usePetState> | undefined;
    function Consumer() {
      latest = usePetState();
      return null;
    }
    const root = createRoot(document.createElement("div"));

    await act(async () => {
      root.render(
        <PetStateProvider api={api} snapshotRetryDelay={() => 0}>
          <Consumer />
        </PetStateProvider>,
      );
      await flushMicrotasks();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await flushMicrotasks();
    });

    expect(dispatchCalls).toBe(2);
    expect(attentionCalls).toBe(2);
    expect(latest?.petSessionId).toBe("pet-recovered");
    expect(latest?.surfaceablePendingCount).toBe(4);
    await act(async () => root.unmount());
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
      dispatch: async () => ({ ok: false, code: "invalid-command" }),
      getAttentionSnapshot: async () => ({ surfaceablePendingCount: 0 }),
      onAttentionEvent: () => () => {},
      setActiveSession: async () => ({ ok: true }),
      markAttentionReceipt: async () => ({ ok: true }),
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

  test("replays Pet stream events that arrive while the durable transcript is still loading", async () => {
    ensureMiniDom();
    let streamListener: ((envelope: any) => void) | undefined;
    let resolveTranscript: ((items: any[]) => void) | undefined;
    const testWindow = window as unknown as Record<string, unknown>;
    const originalCodeshell = testWindow.codeshell;
    testWindow.codeshell = {
      getSessionTranscript: () =>
        new Promise<any[]>((resolve) => {
          resolveTranscript = resolve;
        }),
      onStreamEvent: (listener: (envelope: any) => void) => {
        streamListener = listener;
        return () => {
          streamListener = undefined;
        };
      },
    };
    const api: PetApi = {
      getSnapshot: async () => snapshot(),
      onProjectionEvent: () => () => {},
      openSession: async () => ({ status: "not-found" }),
      dispatch: async (command) =>
        command.type === "get_global_status"
          ? {
              ok: true,
              type: "global_status",
              version: 0,
              generation: 0,
              observedAt: 1,
              workerState: "active",
              petSessionId: "pet-buffered",
              runningCount: 0,
              queuedCount: 0,
              pendingCount: 0,
              sessions: [],
            }
          : { ok: false, code: "invalid-command" },
      getAttentionSnapshot: async () => ({ surfaceablePendingCount: 0 }),
      onAttentionEvent: () => () => {},
      setActiveSession: async () => ({ ok: true }),
      markAttentionReceipt: async () => ({ ok: true }),
    };
    let latest: ReturnType<typeof usePetState> | undefined;
    function Consumer() {
      latest = usePetState();
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => {
      root.render(
        <PetStateProvider api={api}>
          <Consumer />
        </PetStateProvider>,
      );
      await flushMicrotasks();
    });

    await act(async () => {
      streamListener?.({
        sessionId: "pet-buffered",
        event: { type: "stream_request_start", messageId: "assistant-live" },
      });
      streamListener?.({
        sessionId: "pet-buffered",
        event: { type: "text_delta", text: "无需刷新" },
      });
      resolveTranscript?.([]);
      await flushMicrotasks();
    });

    expect(latest?.chatState.messages).toContainEqual(
      expect.objectContaining({ kind: "assistant", text: "无需刷新" }),
    );
    expect(latest?.chatBusy).toBe(true);
    await act(async () => {
      streamListener?.({ sessionId: "pet-buffered", event: { type: "turn_complete" } });
    });
    expect(latest?.chatBusy).toBe(false);

    await act(async () => root.unmount());
    if (originalCodeshell === undefined) delete testWindow.codeshell;
    else testWindow.codeshell = originalCodeshell;
  });

  test("hydrates the durable pet transcript and routes only its main stream bucket", async () => {
    ensureMiniDom();
    let streamListener: ((envelope: any) => void) | undefined;
    let chatListener: Parameters<NonNullable<PetApi["onChatEvent"]>>[0] | undefined;
    const testWindow = window as unknown as Record<string, unknown>;
    const originalCodeshell = testWindow.codeshell;
    testWindow.codeshell = {
      getSessionTranscript: async () => [{ kind: "user", text: "durable history" }],
      onStreamEvent: (listener: (envelope: any) => void) => {
        streamListener = listener;
        return () => {
          streamListener = undefined;
        };
      },
    };
    const api: PetApi = {
      getSnapshot: async () => snapshot(),
      onProjectionEvent: () => () => {},
      openSession: async () => ({ status: "not-found" }),
      onChatEvent: (listener) => {
        chatListener = listener;
        return () => {
          if (chatListener === listener) chatListener = undefined;
        };
      },
      dispatch: async (command) =>
        command.type === "get_global_status"
          ? {
              ok: true,
              type: "global_status",
              version: 0,
              generation: 0,
              observedAt: 1,
              workerState: "reclaimed",
              petSessionId: "pet-one",
              runningCount: 0,
              queuedCount: 0,
              pendingCount: 0,
              sessions: [],
            }
          : { ok: false, code: "invalid-command" },
      getAttentionSnapshot: async () => ({ surfaceablePendingCount: 0 }),
      onAttentionEvent: () => () => {},
      setActiveSession: async () => ({ ok: true }),
      markAttentionReceipt: async () => ({ ok: true }),
    };
    let latest: ReturnType<typeof usePetState> | undefined;
    function Consumer() {
      latest = usePetState();
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => {
      root.render(
        <PetStateProvider api={api}>
          <Consumer />
        </PetStateProvider>,
      );
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(latest?.petSessionId).toBe("pet-one");
    expect(latest?.chatState.messages[0]).toMatchObject({
      kind: "user",
      text: "durable history",
    });
    await act(async () => {
      const event = {
        kind: "user-submitted" as const,
        clientMessageId: "shared-submit",
        message: "visible in every Pet window",
        createdAt: 3,
      };
      chatListener?.(event);
      chatListener?.(event);
    });
    expect(
      latest?.chatState.messages.filter(
        (message) => message.kind === "user" && message.clientMessageId === "shared-submit",
      ),
    ).toHaveLength(1);
    await act(async () => {
      streamListener?.({ sessionId: "work-one", event: { type: "stream_request_start" } });
      streamListener?.({ sessionId: "pet-one", event: { type: "stream_request_start" } });
    });
    expect(latest?.chatBusy).toBe(true);
    await act(async () => {
      streamListener?.({ sessionId: "pet-one", event: { type: "turn_complete" } });
    });
    expect(latest?.chatBusy).toBe(false);

    await act(async () => root.unmount());
    if (originalCodeshell === undefined) delete testWindow.codeshell;
    else testWindow.codeshell = originalCodeshell;
  });
});

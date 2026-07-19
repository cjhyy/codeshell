import { describe, expect, test } from "bun:test";
import { createPetApi, type PetProjectionEvent, type PetProjectionSnapshot } from "./pet-api";

describe("Pet preload contract", () => {
  test("gets a snapshot and gives every subscriber an isolated removable listener", async () => {
    const handlers = new Map<string, Set<(event: unknown, payload: unknown) => void>>();
    const snapshot: PetProjectionSnapshot = {
      version: 0,
      generation: 0,
      workerState: "reclaimed",
      sessions: [],
      pending: [],
      observedAt: 1,
    };
    const ipc = {
      sent: [] as Array<{ channel: string; payload: unknown }>,
      invoke: async (channel: string, payload?: unknown) => {
        if (channel === "pet:get-snapshot") return snapshot;
        if (channel === "pet:get-attention") return { surfaceablePendingCount: 2 };
        if (channel === "pet:set-active-session") return { ok: true };
        if (channel === "pet:attention-receipt") return { ok: true };
        if (channel === "pet:work-inbox-dismissed-get") {
          return { revision: 2, dismissedIds: ["completed:session-a"] };
        }
        if (channel === "pet:work-inbox-dismissed-update") {
          expect(payload).toEqual({ action: "add", ids: ["other:session-b"] });
          return {
            revision: 3,
            dismissedIds: ["completed:session-a", "other:session-b"],
          };
        }
        if (channel === "pet:long-tasks-get") {
          return { revision: 1, observedAt: 5, tasks: [] };
        }
        if (channel === "pet:long-task-control") {
          expect(payload).toEqual({ taskId: "pet-task-0123456789abcdef01234567", action: "pause" });
          return { ok: false, code: "not-found", message: "gone" };
        }
        if (channel === "pet:widget-visible-get") return false;
        if (channel === "pet:widget-visible") return { ok: true };
        if (channel === "pet:widget-expanded") return { ok: true };
        if (channel === "pet:widget-open-overview") return { ok: true };
        if (channel === "pet:dispatch") {
          expect(payload).toEqual({ type: "get_global_status" });
          return { ok: true, type: "global_status", petSessionId: "pet-one" };
        }
        expect(channel).toBe("pet:open-session");
        expect(payload).toEqual({ agentSessionId: "work-a", snapshotVersion: 1, generation: 0 });
        return { status: "not-found" };
      },
      send(channel: string, payload?: unknown) {
        this.sent.push({ channel, payload });
      },
      on: (channel: string, handler: (event: unknown, payload: unknown) => void) => {
        const channelHandlers = handlers.get(channel) ?? new Set();
        channelHandlers.add(handler);
        handlers.set(channel, channelHandlers);
      },
      removeListener: (channel: string, handler: (event: unknown, payload: unknown) => void) => {
        handlers.get(channel)?.delete(handler);
      },
    };
    const api = createPetApi(ipc);
    const first: PetProjectionEvent[] = [];
    const second: PetProjectionEvent[] = [];
    const chatMessages: string[] = [];
    const offFirst = api.onProjectionEvent((event) => first.push(event));
    api.onProjectionEvent((event) => second.push(event));
    const offChat = api.onChatEvent?.((event) => chatMessages.push(event.message));
    const delta: PetProjectionEvent = {
      kind: "reset",
      version: 1,
      generation: 0,
      observedAt: 2,
    };

    for (const handler of handlers.get("pet:projection-event") ?? []) handler({}, delta);
    offFirst();
    for (const handler of handlers.get("pet:projection-event") ?? []) {
      handler({}, { ...delta, version: 2 });
    }
    for (const handler of handlers.get("pet:chat-event") ?? []) {
      handler(
        {},
        {
          kind: "user-submitted",
          clientMessageId: "client-one",
          message: "delegate this",
          createdAt: 3,
        },
      );
    }
    offChat?.();

    expect(await api.getSnapshot()).toEqual(snapshot);
    expect(
      await api.openSession({ agentSessionId: "work-a", snapshotVersion: 1, generation: 0 }),
    ).toEqual({ status: "not-found" });
    expect(await api.dispatch({ type: "get_global_status" })).toMatchObject({
      ok: true,
      petSessionId: "pet-one",
    });
    expect(first.map((event) => event.version)).toEqual([1]);
    expect(second.map((event) => event.version)).toEqual([1, 2]);
    expect(handlers.get("pet:projection-event")?.size).toBe(1);
    expect(chatMessages).toEqual(["delegate this"]);
    expect(handlers.get("pet:chat-event")?.size).toBe(0);
    expect(await api.getAttentionSnapshot()).toEqual({ surfaceablePendingCount: 2 });
    expect(await api.setActiveSession("work-a")).toEqual({ ok: true });
    expect(await api.markAttentionReceipt(["receipt"], "dismissed")).toEqual({ ok: true });
    expect(await api.getDismissedWorkItemIds()).toEqual({
      revision: 2,
      dismissedIds: ["completed:session-a"],
    });
    expect(
      await api.updateDismissedWorkItemIds({
        action: "add",
        ids: ["other:session-b"],
      }),
    ).toEqual({
      revision: 3,
      dismissedIds: ["completed:session-a", "other:session-b"],
    });
    const inboxSnapshots: number[] = [];
    const offInbox = api.onDismissedWorkItemIdsChanged((value) =>
      inboxSnapshots.push(value.revision),
    );
    for (const handler of handlers.get("pet:work-inbox-dismissed-changed") ?? []) {
      handler({}, { revision: 4, dismissedIds: [] });
    }
    offInbox();
    for (const handler of handlers.get("pet:work-inbox-dismissed-changed") ?? []) {
      handler({}, { revision: 5, dismissedIds: [] });
    }
    expect(inboxSnapshots).toEqual([4]);
    expect(await api.getLongTasks?.()).toEqual({ revision: 1, observedAt: 5, tasks: [] });
    expect(
      await api.controlLongTask?.({
        taskId: "pet-task-0123456789abcdef01234567",
        action: "pause",
      }),
    ).toEqual({ ok: false, code: "not-found", message: "gone" });
    const taskRevisions: number[] = [];
    const offTasks = api.onLongTasksChanged?.((value) => taskRevisions.push(value.revision));
    for (const handler of handlers.get("pet:long-tasks-changed") ?? []) {
      handler({}, { revision: 2, observedAt: 6, tasks: [] });
    }
    offTasks?.();
    expect(taskRevisions).toEqual([2]);
    expect(await api.getWidgetVisibility()).toBe(false);
    expect(await api.setWidgetVisible(true)).toEqual({ ok: true });
    expect(await api.setWidgetExpanded(true)).toEqual({ ok: true });
    api.moveWidget({ x: 320, y: 180 });
    expect(ipc.sent).toEqual([{ channel: "pet:widget-move", payload: { x: 320, y: 180 } }]);
    expect(await api.openWidgetOverview()).toEqual({ ok: true });
    let overviewOpenCount = 0;
    const offOverview = api.onWidgetOpenOverview(() => {
      overviewOpenCount += 1;
    });
    for (const handler of handlers.get("pet:widget-open-overview") ?? []) handler({}, undefined);
    offOverview();
    for (const handler of handlers.get("pet:widget-open-overview") ?? []) handler({}, undefined);
    expect(overviewOpenCount).toBe(1);
    const visibility: boolean[] = [];
    const offVisibility = api.onWidgetVisibilityChanged((visible) => visibility.push(visible));
    for (const handler of handlers.get("pet:widget-visibility-changed") ?? []) handler({}, false);
    offVisibility();
    expect(visibility).toEqual([false]);
  });
});

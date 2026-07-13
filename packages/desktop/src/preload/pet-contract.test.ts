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
      invoke: async (channel: string, payload?: unknown) => {
        if (channel === "pet:get-snapshot") return snapshot;
        if (channel === "pet:get-attention") return { surfaceablePendingCount: 2 };
        if (channel === "pet:set-active-session") return { ok: true };
        if (channel === "pet:attention-receipt") return { ok: true };
        if (channel === "pet:dispatch") {
          expect(payload).toEqual({ type: "get_global_status" });
          return { ok: true, type: "global_status", petSessionId: "pet-one" };
        }
        expect(channel).toBe("pet:open-session");
        expect(payload).toEqual({ agentSessionId: "work-a", snapshotVersion: 1, generation: 0 });
        return { status: "not-found" };
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
    const offFirst = api.onProjectionEvent((event) => first.push(event));
    api.onProjectionEvent((event) => second.push(event));
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
    expect(await api.getAttentionSnapshot()).toEqual({ surfaceablePendingCount: 2 });
    expect(await api.setActiveSession("work-a")).toEqual({ ok: true });
    expect(await api.markAttentionReceipt(["receipt"], "dismissed")).toEqual({ ok: true });
  });
});

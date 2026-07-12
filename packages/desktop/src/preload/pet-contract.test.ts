import { describe, expect, test } from "bun:test";
import { createPetApi, type PetProjectionEvent, type PetProjectionSnapshot } from "./pet-api";

describe("Pet preload contract", () => {
  test("gets a snapshot and gives every subscriber an isolated removable listener", async () => {
    const handlers = new Set<(event: unknown, payload: PetProjectionEvent) => void>();
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
        expect(channel).toBe("pet:open-session");
        expect(payload).toEqual({ agentSessionId: "work-a", snapshotVersion: 1, generation: 0 });
        return { status: "not-found" };
      },
      on: (channel: string, handler: (event: unknown, payload: PetProjectionEvent) => void) => {
        expect(channel).toBe("pet:projection-event");
        handlers.add(handler);
      },
      removeListener: (
        _channel: string,
        handler: (event: unknown, payload: PetProjectionEvent) => void,
      ) => {
        handlers.delete(handler);
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

    for (const handler of handlers) handler({}, delta);
    offFirst();
    for (const handler of handlers) handler({}, { ...delta, version: 2 });

    expect(await api.getSnapshot()).toEqual(snapshot);
    expect(
      await api.openSession({ agentSessionId: "work-a", snapshotVersion: 1, generation: 0 }),
    ).toEqual({ status: "not-found" });
    expect(first.map((event) => event.version)).toEqual([1]);
    expect(second.map((event) => event.version)).toEqual([1, 2]);
    expect(handlers.size).toBe(1);
  });
});

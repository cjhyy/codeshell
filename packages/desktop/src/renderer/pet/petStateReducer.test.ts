import { describe, expect, test } from "bun:test";
import type { PetProjectionEvent, PetProjectionSnapshot } from "../../preload/types";
import { initialPetState, petStateReducer } from "./petStateReducer";

function snapshot(overrides: Partial<PetProjectionSnapshot> = {}): PetProjectionSnapshot {
  return {
    version: 2,
    generation: 4,
    workerState: "active",
    observedAt: 1_000,
    sessions: [],
    pending: [],
    ...overrides,
  };
}

describe("petStateReducer", () => {
  test("hydrates a snapshot and applies exactly ordered same-generation deltas", () => {
    let state = petStateReducer(initialPetState, {
      type: "snapshot-received",
      snapshot: snapshot(),
    });
    const event: PetProjectionEvent = {
      kind: "session-upsert",
      generation: 4,
      version: 3,
      observedAt: 1_100,
      session: {
        agentSessionId: "one",
        title: "One",
        runState: "running",
        queueDepth: 0,
        lastActivityAt: 1_100,
        pendingDecisionCount: 0,
        freshness: { source: "live-event", observedAt: 1_100, workerState: "active" },
      },
    };

    state = petStateReducer(state, { type: "projection-event", event });

    expect(state.projection?.sessions).toHaveLength(1);
    expect(state.projection?.version).toBe(3);
    expect(state.needsSnapshot).toBe(false);
  });

  test("does not guess across gaps, generation mismatches or reset events", () => {
    const hydrated = petStateReducer(initialPetState, {
      type: "snapshot-received",
      snapshot: snapshot(),
    });
    const events: PetProjectionEvent[] = [
      { kind: "reset", generation: 4, version: 3, observedAt: 1_100 },
      { kind: "reset", generation: 5, version: 1, observedAt: 1_200 },
      { kind: "reset", generation: 4, version: 5, observedAt: 1_300 },
    ];
    for (const event of events) {
      const state = petStateReducer(hydrated, { type: "projection-event", event });
      expect(state.needsSnapshot).toBe(true);
      expect(state.status).toBe("reconciling");
      expect(state.projection).toEqual(hydrated.projection);
    }

    const afterGap = petStateReducer(hydrated, {
      type: "projection-event",
      event: { kind: "reset", generation: 4, version: 5, observedAt: 1_300 },
    });
    const cannotHealFromTail = petStateReducer(afterGap, {
      type: "projection-event",
      event: {
        kind: "worker-state",
        generation: 4,
        version: 3,
        observedAt: 1_400,
        state: "active",
      },
    });
    expect(cannotHealFromTail).toBe(afterGap);
  });

  test("projection events never open overview and closing preserves projection, draft and transcript", () => {
    let state = petStateReducer(initialPetState, { type: "set-overview-open", open: true });
    state = petStateReducer(state, { type: "set-chat-draft", draft: "hello" });
    state = petStateReducer(state, { type: "set-chat-transcript", transcript: [{ id: "m1" }] });
    state = petStateReducer(state, { type: "snapshot-received", snapshot: snapshot() });
    state = petStateReducer(state, {
      type: "projection-event",
      event: {
        kind: "worker-state",
        generation: 4,
        version: 3,
        observedAt: 1_100,
        state: "reclaimed",
      },
    });
    state = petStateReducer(state, { type: "set-overview-open", open: false });

    expect(state.overviewOpen).toBe(false);
    expect(state.projection?.workerState).toBe("reclaimed");
    expect(state.chatDraft).toBe("hello");
    expect(state.chatTranscript).toEqual([{ id: "m1" }]);

    const closed = petStateReducer(
      { ...state, overviewOpen: false },
      {
        type: "projection-event",
        event: { kind: "reset", generation: 5, version: 1, observedAt: 1_200 },
      },
    );
    expect(closed.overviewOpen).toBe(false);
  });
});

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

  test("applies a work-memory-segments event onto the held projection", () => {
    let state = petStateReducer(initialPetState, {
      type: "snapshot-received",
      snapshot: snapshot({ workMemorySegments: [] }),
    });
    state = petStateReducer(state, {
      type: "projection-event",
      event: {
        kind: "work-memory-segments",
        generation: 4,
        version: 3,
        observedAt: 1_100,
        segments: [{ boundaryBeforeMessageId: "pet-a", brief: "未完成任务:\n- 重构 X" }],
      },
    });
    expect(state.projection?.workMemorySegments).toEqual([
      { boundaryBeforeMessageId: "pet-a", brief: "未完成任务:\n- 重构 X" },
    ]);
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

  test("projection events preserve page-local focus, draft and transcript state", () => {
    let state = petStateReducer(initialPetState, {
      type: "set-overview-focus",
      focus: "pending",
    });
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
    expect(state.projection?.workerState).toBe("reclaimed");
    expect(state.overviewFocus).toBe("pending");
    expect(state.chatDraft).toBe("hello");
    expect(state.chatTranscript).toEqual([{ id: "m1" }]);

    const closed = petStateReducer(state, {
      type: "projection-event",
      event: { kind: "reset", generation: 5, version: 1, observedAt: 1_200 },
    });
    expect(closed.overviewFocus).toBe("pending");
  });

  test("can schedule a snapshot retry after an early IPC startup race", () => {
    const failed = petStateReducer(initialPetState, {
      type: "snapshot-failed",
      error: "handler not ready",
    });
    expect(petStateReducer(failed, { type: "snapshot-retry" })).toMatchObject({
      status: "reconciling",
      needsSnapshot: true,
      error: undefined,
    });

    const reconciling = petStateReducer(initialPetState, { type: "snapshot-retry" });
    expect(
      petStateReducer(reconciling, {
        type: "snapshot-failed",
        error: "still starting",
      }),
    ).toMatchObject({ status: "error", needsSnapshot: true, error: "still starting" });
  });
});

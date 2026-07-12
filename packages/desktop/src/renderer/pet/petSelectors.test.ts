import { describe, expect, test } from "bun:test";
import type { PetProjectionSnapshot, PetSessionProjection } from "../../preload/types";
import { selectPetOverview } from "./petSelectors";

function session(
  agentSessionId: string,
  runState: PetSessionProjection["runState"],
  overrides: Partial<PetSessionProjection> = {},
): PetSessionProjection {
  return {
    agentSessionId,
    title: agentSessionId,
    runState,
    queueDepth: 0,
    lastActivityAt: 1_000,
    pendingDecisionCount: 0,
    freshness: { source: "live-event", observedAt: 10_000, workerState: "active" },
    ...overrides,
  };
}

function snapshot(overrides: Partial<PetProjectionSnapshot> = {}): PetProjectionSnapshot {
  return {
    version: 3,
    generation: 1,
    workerState: "active",
    observedAt: 10_000,
    sessions: [],
    pending: [],
    ...overrides,
  };
}

describe("selectPetOverview", () => {
  test("derives counts and stable waiting/running/queued/rest ordering from one snapshot", () => {
    const result = selectPetOverview(
      snapshot({
        sessions: [
          session("unknown", "unknown"),
          session("idle", "idle"),
          session("queued", "queued", { queueDepth: 2 }),
          session("running", "running"),
          session("waiting", "running", { pendingDecisionCount: 1 }),
        ],
      }),
      "ready",
      11_000,
    );

    expect(result.runningCount).toBe(2);
    expect(result.queuedCount).toBe(1);
    expect(result.sessions.map((entry) => entry.agentSessionId)).toEqual([
      "waiting",
      "running",
      "queued",
      "idle",
      "unknown",
    ]);
  });

  test("shows every current pending immediately and distinguishes reclaimed from disconnected", () => {
    const current = {
      agentSessionId: "work-a",
      requestId: "req-a",
      workerGeneration: 1,
      kind: "ask_user" as const,
      title: "Choose a plan",
      createdAt: 9_000,
      status: "pending" as const,
    };
    const resolved = { ...current, requestId: "req-b", status: "resolved" as const };
    const result = selectPetOverview(
      snapshot({ workerState: "reclaimed", pending: [current, resolved] }),
      "ready",
      11_000,
    );

    expect(result.pending).toEqual([current]);
    expect(result.pendingCount).toBe(1);
    expect(result.emptyState).toBe("reclaimed");

    const disconnected = selectPetOverview(
      snapshot({ workerState: "disconnected" }),
      "ready",
      11_000,
    );
    expect(disconnected.emptyState).toBe("disconnected");
  });
});

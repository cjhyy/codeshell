import { describe, expect, test } from "bun:test";
import type { PetProjectionSnapshot, PetSessionProjection } from "../../preload/types";
import {
  buildPetWidgetActivity,
  initialPetWidgetReceiptState,
  markPetWidgetCompletionSeen,
  parsePetWidgetReceiptState,
} from "./petWidgetActivity";

function session(id: string, patch: Partial<PetSessionProjection> = {}): PetSessionProjection {
  return {
    agentSessionId: id,
    title: id,
    runState: "idle",
    queueDepth: 0,
    lastActivityAt: 100,
    pendingDecisionCount: 0,
    freshness: { source: "disk", observedAt: 100, workerState: "active" },
    ...patch,
  };
}

function snapshot(sessions: PetSessionProjection[]): PetProjectionSnapshot {
  return {
    version: 3,
    generation: 2,
    workerState: "active",
    sessions,
    pending: [],
    observedAt: 200,
  };
}

describe("Pet widget work activity", () => {
  test("counts active sessions and only completions newer than the persisted baseline", () => {
    const value = snapshot([
      session("running", { runState: "running", lastActivityAt: 350 }),
      session("old", { runState: "terminal", terminal: { status: "completed", at: 150 } }),
      session("new", { runState: "terminal", terminal: { status: "completed", at: 300 } }),
    ]);

    const activity = buildPetWidgetActivity(value, { baselineAt: 200, seenCompletionKeys: [] });

    expect(activity.badgeCount).toBe(2);
    expect(activity.runningCount).toBe(1);
    expect(activity.unreadCompletedCount).toBe(1);
    expect(activity.items.map((item) => item.agentSessionId)).toEqual(["running", "new"]);
  });

  test("deduplicates a running session that is also waiting for a decision", () => {
    const value = snapshot([session("work", { runState: "running", lastActivityAt: 250 })]);
    value.pending.push({
      agentSessionId: "work",
      requestId: "ask-1",
      workerGeneration: 2,
      kind: "ask_user",
      title: "选择方案",
      createdAt: 300,
      status: "pending",
    });

    const activity = buildPetWidgetActivity(value, { baselineAt: 200, seenCompletionKeys: [] });

    expect(activity.badgeCount).toBe(1);
    expect(activity.items[0]).toMatchObject({ kind: "needs-action", requestId: "ask-1" });
  });

  test("clears an unread completion only after that completion row is seen", () => {
    const value = snapshot([
      session("done", { runState: "terminal", terminal: { status: "completed", at: 300 } }),
    ]);
    const receipts = markPetWidgetCompletionSeen(
      { baselineAt: 200, seenCompletionKeys: [] },
      "completed:done:300",
    );

    expect(buildPetWidgetActivity(value, receipts).badgeCount).toBe(0);
    expect(parsePetWidgetReceiptState(JSON.stringify(receipts))).toEqual(receipts);
    expect(initialPetWidgetReceiptState(value).baselineAt).toBe(200);
  });
});

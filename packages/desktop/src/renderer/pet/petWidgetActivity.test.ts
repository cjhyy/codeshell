import { describe, expect, test } from "bun:test";
import type {
  PetLongTask,
  PetLongTaskSnapshot,
  PetProjectionSnapshot,
  PetSessionProjection,
} from "../../preload/types";
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

function longTask(patch: Partial<PetLongTask> = {}): PetLongTask {
  return {
    schemaVersion: 1,
    id: "task-one",
    originClientMessageId: "message-one",
    objective: "Codex 只读调查 JPEG 报错",
    workspacePath: "/work/codeshell",
    sessionId: "work",
    verificationMode: "turn",
    status: "running",
    phase: "executing",
    attempt: 1,
    revision: 2,
    createdAt: 210,
    updatedAt: 300,
    summary: "等待后台结果",
    artifacts: [],
    events: [],
    ...patch,
  };
}

function longTaskSnapshot(tasks: PetLongTask[]): PetLongTaskSnapshot {
  return { revision: 4, observedAt: 400, tasks };
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

  test("never surfaces dormant sessions and clears only the clicked completion", () => {
    const value = snapshot([
      session("done-a", { runState: "terminal", terminal: { status: "completed", at: 300 } }),
      session("done-b", { runState: "terminal", terminal: { status: "completed", at: 400 } }),
      session("dormant", { runState: "dormant", lastActivityAt: 500 }),
    ]);
    const initial = { baselineAt: 200, seenCompletionKeys: [] };
    const activity = buildPetWidgetActivity(value, initial);
    expect(activity.items.map((item) => item.agentSessionId)).toEqual(["done-b", "done-a"]);
    const seen = markPetWidgetCompletionSeen(initial, activity.items[0].key);
    const remaining = buildPetWidgetActivity(value, seen);
    expect(remaining.items.map((item) => item.agentSessionId)).toEqual(["done-a"]);
    expect(remaining).toMatchObject({ unreadCompletedCount: 1, badgeCount: 1 });
  });

  test("lets a durable completion replace a stale running Session projection", () => {
    const value = snapshot([
      session("work", {
        title: "Codex 只读调查 JPEG 报错",
        runState: "running",
        lastActivityAt: 250,
        summary: "等待后台结果",
      }),
    ]);
    const tasks = longTaskSnapshot([
      longTask({
        status: "completed",
        phase: "finalizing",
        revision: 5,
        updatedAt: 350,
        completedAt: 340,
        summary: "调查已完成",
      }),
    ]);

    const activity = buildPetWidgetActivity(
      value,
      { baselineAt: 200, seenCompletionKeys: [] },
      tasks,
    );

    expect(activity).toMatchObject({ runningCount: 0, unreadCompletedCount: 1, badgeCount: 1 });
    expect(activity.items).toEqual([
      expect.objectContaining({
        key: "completed-task:task-one:340",
        agentSessionId: "work",
        kind: "completed",
        detail: "调查已完成",
      }),
    ]);
  });

  test("does not let an older durable result overwrite a newer Session run", () => {
    const value = snapshot([
      session("work", { runState: "running", lastActivityAt: 500, summary: "新一轮正在运行" }),
    ]);
    const tasks = longTaskSnapshot([
      longTask({ status: "completed", updatedAt: 350, completedAt: 340 }),
    ]);

    const activity = buildPetWidgetActivity(
      value,
      { baselineAt: 200, seenCompletionKeys: [] },
      tasks,
    );

    expect(activity).toMatchObject({ runningCount: 1, unreadCompletedCount: 0 });
    expect(activity.items[0]).toMatchObject({ kind: "working", detail: "新一轮正在运行" });
  });

  test("treats a newer background-wait projection as stale after durable closure", () => {
    const value = snapshot([
      session("work", {
        runState: "running",
        lastActivityAt: 352,
        summary: "等待后台结果",
      }),
    ]);
    const tasks = longTaskSnapshot([
      longTask({
        status: "completed",
        phase: "finalizing",
        updatedAt: 350,
        completedAt: 340,
        summary: "调查已完成",
      }),
    ]);

    const activity = buildPetWidgetActivity(
      value,
      { baselineAt: 200, seenCompletionKeys: [] },
      tasks,
    );

    expect(activity).toMatchObject({ runningCount: 0, unreadCompletedCount: 1 });
    expect(activity.items[0]).toMatchObject({ kind: "completed", detail: "调查已完成" });
  });
});

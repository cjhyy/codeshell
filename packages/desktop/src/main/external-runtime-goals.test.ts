import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type StreamEvent } from "@cjhyy/code-shell-core";
import { ExternalRuntimeGoals } from "./external-runtime-goals.js";

let previousHome: string | undefined;
let testHome: string;
let manager: SessionManager;
let goals: ExternalRuntimeGoals;
let events: StreamEvent[];
let now: number;
const sessionId = "external-goal-test";

beforeEach(() => {
  previousHome = process.env.CODE_SHELL_HOME;
  testHome = mkdtempSync(join(tmpdir(), "codeshell-external-goals-"));
  process.env.CODE_SHELL_HOME = testHome;
  manager = new SessionManager();
  manager.create("/tmp/project", "codex/test", "codex", sessionId, null, "desktop");
  now = 10_000;
  events = [];
  goals = new ExternalRuntimeGoals(
    (_sessionId, event) => events.push(event),
    () => now,
  );
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previousHome;
  rmSync(testHome, { recursive: true, force: true });
});

describe("external Goal lifecycle", () => {
  test("persists an explicit goal before publishing it and recovers its canonical identity", () => {
    const run = goals.start(sessionId, { objective: "完成独立测试", maxTurns: 2 })!;
    expect(manager.readSessionState(sessionId)?.goalLifecycle).toMatchObject({
      version: 1,
      phase: "active",
      goalId: run.goal.goalId,
      revision: 1,
      config: { objective: "完成独立测试", maxTurns: 2 },
    });
    expect(events).toEqual([
      {
        type: "goal_set",
        goalId: run.goal.goalId,
        revision: 1,
        objective: "完成独立测试",
        replaced: false,
      },
    ]);
    const restored = new ExternalRuntimeGoals(() => {});
    expect(restored.get(sessionId)).toEqual(goals.get(sessionId));
    goals.end(run);
    expect(goals.start(sessionId)?.goal.goalId).toBe(run.goal.goalId);
    expect(events).toHaveLength(1);
  });

  test("does not create a goal from a normal send and disableGoal leaves persisted state intact", () => {
    expect(goals.start(sessionId)).toBeUndefined();
    expect(goals.start(sessionId, "ignored explicit goal", true)).toBeUndefined();
    expect(goals.get(sessionId).goal).toBeNull();
    const run = goals.start(sessionId, "保留目标")!;
    goals.end(run);
    expect(goals.start(sessionId, undefined, true)).toBeUndefined();
    expect(goals.get(sessionId).goalId).toBe(run.goal.goalId);
    expect(() => goals.start(sessionId, { objective: "", maxTurns: 2 })).toThrow();
    expect(() => goals.start(sessionId, { objective: "bad", tokenBudget: NaN })).toThrow();
  });

  test("pause and edit use revision fences; stale completion cannot clear the new objective", () => {
    const run = goals.start(sessionId, "旧目标")!;
    const edited = goals.update(sessionId, {
      objective: "修订目标",
      expectedGoalId: run.goal.goalId!,
      expectedRevision: 1,
    });
    expect(edited).toMatchObject({ updated: true, revision: 2, goal: "修订目标" });
    expect(goals.settle(sessionId, "completed", { goalId: run.goal.goalId, revision: 1 }).ok).toBe(
      false,
    );
    const resumed = goals.start(sessionId)!;
    expect(goals.settle(sessionId, "completed", { goalId: run.goal.goalId, revision: 1 }).ok).toBe(
      false,
    );
    const paused = goals.update(sessionId, {
      paused: true,
      expectedGoalId: resumed.goal.goalId!,
      expectedRevision: resumed.goal.revision!,
    });
    expect(paused.paused).toBe(true);
    expect(goals.start(sessionId)).toBeUndefined();
    expect(goals.get(sessionId).goal).toBe("修订目标");
  });

  test("only a matching explicit completion publishes met and makes the lifecycle terminal", () => {
    const run = goals.start(sessionId, "完成目标")!;
    expect(
      goals.settle(sessionId, "completed", {
        goalId: run.goal.goalId,
        revision: run.goal.revision,
        summary: "已通过验收",
      }),
    ).toEqual({ ok: true, status: "completed" });
    expect(manager.readSessionState(sessionId)?.goalLifecycle).toMatchObject({
      phase: "terminal",
      terminal: { reason: "completed" },
    });
    expect(goals.get(sessionId).goal).toBeNull();
    expect(events.at(-1)).toMatchObject({ type: "goal_progress", status: "met" });
  });

  test("cancellation requires the user's reason and replacement rejects the previous goal identity", () => {
    const old = goals.start(sessionId, "旧目标")!;
    const run = goals.start(sessionId, "新目标")!;
    expect(
      goals.settle(sessionId, "completed", {
        goalId: old.goal.goalId,
        revision: 1,
      }).ok,
    ).toBe(false);
    const identity = { goalId: run.goal.goalId, revision: run.goal.revision };
    expect(goals.settle(sessionId, "cancelled", { ...identity, confirm: true }).ok).toBe(false);
    expect(
      goals.settle(sessionId, "cancelled", {
        ...identity,
        confirm: true,
        reason: "用户要求取消",
      }).ok,
    ).toBe(true);
    expect(manager.readSessionState(sessionId)?.goalLifecycle).toMatchObject({
      phase: "terminal",
      terminal: { reason: "cancelled" },
    });
    expect(events.at(-1)).toMatchObject({ type: "goal_cleared", ...identity });
  });

  test("provider turns continue within their bound, then pause without claiming achievement", () => {
    const run = goals.start(sessionId, { objective: "继续处理", maxTurns: 2 })!;
    expect(goals.afterTurn(run, 10, "第一轮结果")).toBe(true);
    expect(goals.afterTurn(run, 10, "第二轮结果")).toBe(false);
    expect(goals.get(sessionId)).toMatchObject({ goal: "继续处理", paused: true, revision: 2 });
    expect(events.some((event) => event.type === "goal_progress" && event.status === "met")).toBe(
      false,
    );
    expect(events.at(-1)).toMatchObject({ type: "goal_progress", status: "not_met" });
  });

  test("extensions raise only the active run ceilings and stale controls cannot delete a goal", () => {
    const run = goals.start(sessionId, { objective: "执行", maxTurns: 2, timeBudgetMs: 100 })!;
    run.tokensUsed = 50;
    expect(
      goals.extend(sessionId, { addTurns: 2, addTokenBudget: 20, addTimeBudgetMs: 50 }),
    ).toEqual({
      ok: true,
      limits: { maxTurns: 4, maxStopBlocks: 3, tokenBudget: 70, timeBudgetMs: 150 },
    });
    expect(
      goals.delete(sessionId, { expectedGoalId: run.goal.goalId, expectedRevision: 9 }).cleared,
    ).toBe(false);
    now += 150;
    expect(goals.afterTurn(run, 1, "新结果")).toBe(false);
    expect(goals.get(sessionId).paused).toBe(true);
    expect(() => goals.extend(sessionId, { addTurns: 2 })).toThrow(/No active/);
  });

  test("failed persistence publishes no goal_set or completion", () => {
    const save = spyOn(SessionManager.prototype, "saveActiveGoal").mockReturnValue(false);
    try {
      expect(() => goals.start(sessionId, "保存失败的目标")).toThrow(/persist/);
      expect(events).toEqual([]);
      expect(goals.get(sessionId).goal).toBeNull();
    } finally {
      save.mockRestore();
    }
    const run = goals.start(sessionId, "仍未完成")!;
    const terminal = spyOn(SessionManager.prototype, "saveGoalTerminalOutcome").mockReturnValue(
      "failed",
    );
    try {
      expect(
        goals.settle(sessionId, "completed", {
          goalId: run.goal.goalId,
          revision: run.goal.revision,
        }).ok,
      ).toBe(false);
      expect(events).toHaveLength(1);
      expect(goals.get(sessionId).goal).toBe("仍未完成");
    } finally {
      terminal.mockRestore();
    }
  });
});

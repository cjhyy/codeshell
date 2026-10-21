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
        setAtMs: 10_000,
      },
    ]);
    expect(goals.get(sessionId).setAtMs).toBe(10_000);
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

  test("background waiting preserves the Goal and re-arms the same version on completion", () => {
    const run = goals.start(sessionId, "收集后台结果")!;
    expect(goals.afterTurn(run, 20, "后台任务进行中", true)).toBe(true);
    expect(events).toHaveLength(1);
    expect(goals.waitForBackgroundWork(run)).toBe(true);
    expect(manager.readSessionState(sessionId)?.goalLifecycle).toMatchObject({
      phase: "waiting",
      goalId: run.goal.goalId,
      revision: run.goal.revision,
      waitingFor: "finite_background_work",
    });
    expect(goals.get(sessionId)).toMatchObject({ goal: "收集后台结果", paused: false });
    expect(events.at(-1)).toMatchObject({
      type: "goal_progress",
      status: "not_met",
      gaps: "等待后台任务完成，完成后自动继续。",
    });
    expect(events.some((event) => event.type === "goal_progress" && event.status === "met")).toBe(
      false,
    );
    goals.end(run);

    const resumed = goals.start(sessionId)!;
    expect(resumed.goal).toEqual(run.goal);
    expect(manager.readSessionState(sessionId)?.goalLifecycle).toMatchObject({
      phase: "active",
      goalId: run.goal.goalId,
      revision: run.goal.revision,
    });
    expect(events.filter((event) => event.type === "goal_set")).toHaveLength(1);
  });

  test("stale or failed background waiting never publishes a waiting transition", () => {
    const run = goals.start(sessionId, "后台任务")!;
    const waiting = spyOn(SessionManager.prototype, "markGoalWaiting").mockReturnValue(false);
    try {
      expect(goals.waitForBackgroundWork(run)).toBe(false);
      expect(manager.readSessionState(sessionId)?.goalLifecycle?.phase).toBe("active");
      expect(events).toHaveLength(1);
    } finally {
      waiting.mockRestore();
    }
    goals.update(sessionId, {
      objective: "修订后的后台任务",
      expectedGoalId: run.goal.goalId!,
      expectedRevision: run.goal.revision!,
    });
    const eventCount = events.length;
    expect(goals.waitForBackgroundWork(run)).toBe(false);
    expect(events).toHaveLength(eventCount);
    expect(manager.readSessionState(sessionId)?.goalLifecycle).toMatchObject({
      phase: "active",
      revision: 2,
      config: { objective: "修订后的后台任务" },
    });
  });

  test("waiting still enforces Goal budgets before parking", () => {
    const run = goals.start(sessionId, { objective: "限额后台任务", tokenBudget: 10 })!;
    expect(goals.afterTurn(run, 10, "任务启动", true)).toBe(false);
    expect(run.tokensUsed).toBe(10);
    expect(goals.waitForBackgroundWork(run)).toBe(false);
    expect(goals.get(sessionId).paused).toBe(true);
    expect(manager.readSessionState(sessionId)?.goalLifecycle?.phase).toBe("paused");
  });

  test("an inherited Goal is not re-armed over an edit between the read and write", () => {
    const run = goals.start(sessionId, "旧后台任务")!;
    expect(goals.waitForBackgroundWork(run)).toBe(true);
    goals.end(run);
    const read = spyOn(SessionManager.prototype, "readActiveGoal");
    read.mockImplementationOnce(() => {
      manager.updateActiveGoal(sessionId, {
        objective: "修订后台任务",
        expectedGoalId: run.goal.goalId!,
        expectedRevision: run.goal.revision!,
      });
      return run.goal;
    });
    try {
      expect(() => goals.start(sessionId)).toThrow(/re-arm/);
      expect(manager.readSessionState(sessionId)?.goalLifecycle).toMatchObject({
        phase: "active",
        revision: 2,
        config: { objective: "修订后台任务" },
      });
    } finally {
      read.mockRestore();
    }
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

  test("a yielded run stops continuing without pausing the persisted Goal", () => {
    const run = goals.start(sessionId, { objective: "让位给用户" })!;
    expect(goals.yieldAfterTurn(sessionId)).toBe(true);
    expect(goals.afterTurn(run, 10, "本轮结果")).toBe(false);
    expect(goals.get(sessionId)).toMatchObject({ goal: "让位给用户", paused: false, revision: 1 });
    goals.end(run);
    expect(goals.yieldAfterTurn(sessionId)).toBe(false);
  });

  test("wait_for_user ends the run without pausing and keeps the question until the user replies", () => {
    const run = goals.start(sessionId, { objective: "安装面板" })!;
    expect(
      goals.waitForUser(sessionId, {
        goalId: run.goal.goalId,
        revision: run.goal.revision,
        question: "允许三项新权限并安装吗？",
      }),
    ).toMatchObject({ ok: true });
    expect(events.at(-1)).toMatchObject({
      type: "goal_progress",
      status: "not_met",
      waitingForUser: "允许三项新权限并安装吗？",
    });
    expect(goals.afterTurn(run, 10, "已提问")).toBe(false);
    expect(goals.get(sessionId)).toMatchObject({ goal: "安装面板", paused: false });
    goals.end(run);
    expect(goals.pendingQuestion(sessionId)).toBe("允许三项新权限并安装吗？");
    // A resume or other automatic continuation must still see the open question.
    const resumed = goals.start(sessionId)!;
    expect(goals.instruction(resumed)).toContain("允许三项新权限并安装吗？");
    goals.end(resumed);
    goals.userReplied(sessionId);
    expect(goals.pendingQuestion(sessionId)).toBeUndefined();
  });

  test("wait_for_user refuses a stale identity or an empty question", () => {
    const run = goals.start(sessionId, { objective: "安装面板" })!;
    expect(
      goals.waitForUser(sessionId, { goalId: "other", revision: 1, question: "继续吗？" }),
    ).toMatchObject({ ok: false });
    expect(
      goals.waitForUser(sessionId, {
        goalId: run.goal.goalId,
        revision: run.goal.revision,
        question: "   ",
      }),
    ).toMatchObject({ ok: false });
    expect(goals.pendingQuestion(sessionId)).toBeUndefined();
    expect(goals.afterTurn(run, 10, "继续")).toBe(true);
  });

  test("the continuation instruction says it is not a user reply or approval", () => {
    const run = goals.start(sessionId, { objective: "安装面板" })!;
    expect(goals.instruction(run)).toContain("not a reply from the user");
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

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
    // A wait, not an unmet verdict: no gaps text, a waiting marker instead.
    expect(events.at(-1)).toMatchObject({
      type: "goal_progress",
      status: "not_met",
      round: 1,
      waiting: { kind: "background_work", sinceMs: now },
    });
    expect(events.at(-1)).not.toHaveProperty("gaps");
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

  test("rounds and goal time accumulate across wakes; a user wait is not counted", () => {
    // Persistence settles background waits with Date.now(); share the fake clock.
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      accumulateAcrossWakes();
    } finally {
      clock.mockRestore();
    }
  });

  function accumulateAcrossWakes(): void {
    const minute = 60_000;
    const first = goals.start(sessionId, "长期目标")!;
    now += minute;
    expect(goals.afterTurn(first, 10, "派出后台任务", true)).toBe(true);
    const tasks = [{ kind: "job", label: "DriveAgent(codex): 修样式" }];
    expect(goals.waitForBackgroundWork(first, tasks)).toBe(true);
    expect(events.at(-1)).toMatchObject({
      round: 1,
      waiting: { kind: "background_work", sinceMs: now, tasks },
      progress: { rounds: 1, activeMs: minute, atMs: now },
    });
    goals.end(first);

    // The background work runs for 20 minutes, then its completion wakes the goal.
    now += 20 * minute;
    const second = goals.start(sessionId)!;
    now += 2 * minute;
    expect(goals.afterTurn(second, 10, "再派一个", true)).toBe(true);
    expect(goals.waitForBackgroundWork(second)).toBe(true);
    expect(events.at(-1)).toMatchObject({
      round: 2,
      progress: { rounds: 2, activeMs: 23 * minute },
    });
    goals.end(second);

    now += 5 * minute;
    const third = goals.start(sessionId)!;
    now += minute;
    goals.waitForUser(sessionId, {
      goalId: third.goal.goalId,
      revision: third.goal.revision,
      question: "要发布吗？",
    });
    expect(events.at(-1)).toMatchObject({
      round: 3,
      waitingForUser: "要发布吗？",
      progress: { rounds: 3, activeMs: 29 * minute },
    });
    expect(goals.afterTurn(third, 10, "等你决定")).toBe(false);
    goals.end(third);

    // Half an hour waiting for the reply is not goal time.
    now += 30 * minute;
    expect(manager.readGoalProgress(sessionId)).toEqual({
      goalId: third.goal.goalId,
      rounds: 3,
      activeMs: 29 * minute,
    });
    // agent/goalGet hands the same totals to a reloading window.
    expect(goals.get(sessionId)).toMatchObject({
      goalId: third.goal.goalId,
      progress: { rounds: 3, activeMs: 29 * minute },
    });
  }

  test("asking the user freezes time even when the provider finishes much later", () => {
    const run = goals.start(sessionId, "等用户确认")!;
    now += 2_000;
    goals.waitForUser(sessionId, {
      goalId: run.goal.goalId,
      revision: run.goal.revision,
      question: "继续吗？",
    });
    now += 600_000;
    goals.afterTurn(run, 10, "请确认");
    goals.end(run);
    expect(manager.readGoalProgress(sessionId)).toMatchObject({ rounds: 1, activeMs: 2_000 });
    goals.userReplied(sessionId);
    const resumed = goals.start(sessionId)!;
    now += 3_000;
    goals.afterTurn(resumed, 10, "继续处理");
    goals.end(resumed);
    expect(manager.readGoalProgress(sessionId)).toMatchObject({ rounds: 2, activeMs: 5_000 });
  });

  test("pausing freezes time before an in-flight provider call has completed", () => {
    const run = goals.start(sessionId, "可暂停的目标")!;
    now += 2_000;
    goals.update(sessionId, {
      paused: true,
      expectedGoalId: run.goal.goalId!,
      expectedRevision: run.goal.revision!,
    });
    now += 600_000;
    goals.afterTurn(run, 10, "工具终于结束");
    goals.end(run);
    expect(manager.readGoalProgress(sessionId)).toMatchObject({ activeMs: 2_000 });
  });

  test("background wait and delayed teardown count the overlapping interval once", () => {
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const run = goals.start(sessionId, "等待后台任务")!;
      now += 2_000;
      goals.afterTurn(run, 10, "后台任务进行中", true);
      expect(goals.waitForBackgroundWork(run)).toBe(true);
      now += 60_000;
      goals.end(run);
      now += 60_000;
      const resumed = goals.start(sessionId)!;
      expect(resumed.progressBase).toEqual({ rounds: 1, activeMs: 122_000 });
      goals.end(resumed);
    } finally {
      clock.mockRestore();
    }
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

  test("the instruction limits repeat questions and lets user acceptance finish a judgment goal", () => {
    const run = goals.start(sessionId, { objective: "优化到没有太多样式差异" })!;
    const text = goals.instruction(run);
    expect(text).toContain("Never ask again a question the user has already answered");
    expect(text).toContain("acceptance of the result as a whole");
    expect(text).not.toContain("restating the pending question");
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

  test("wait_for_user carries structured choices and repeats them to the model", () => {
    const run = goals.start(sessionId, "发版并部署")!;
    const questions = [
      {
        id: "deploy",
        header: "部署方式",
        question: "服务端怎么部署？",
        options: [{ label: "执行机", description: "我写清单" }, { label: "这次不部署" }],
        default: "这次不部署",
      },
    ];
    expect(
      goals.waitForUser(sessionId, {
        goalId: run.goal.goalId,
        revision: run.goal.revision,
        questions,
      }),
    ).toMatchObject({ ok: true });
    expect(events.at(-1)).toMatchObject({
      type: "goal_progress",
      gaps: "等待你的回复",
      waitingForUser: "部署方式: 服务端怎么部署？ [执行机 / 这次不部署]",
      waitingForUserDetail: { level: "preference", questions },
    });
    expect(events.at(-1)).not.toHaveProperty("waitingQuestions");
    // The reminder spells the choices out once, without doubling the question.
    expect(goals.instruction(run)).toContain(
      "your question: 部署方式: 服务端怎么部署？ [执行机 / 这次不部署] It is still",
    );
    expect(goals.instruction(run)).toContain("Never write a multiple-choice question as text");
  });

  test("invalid structured choices are refused before anything is shown", () => {
    const run = goals.start(sessionId, "发版并部署")!;
    const before = events.length;
    expect(
      goals.waitForUser(sessionId, {
        goalId: run.goal.goalId,
        revision: run.goal.revision,
        question: "需要你决定",
        questions: [{ question: "选？", options: [{ label: "A" }] }],
      }),
    ).toMatchObject({ ok: false, message: expect.stringContaining("2 to 4") });
    expect(events).toHaveLength(before);
    expect(goals.pendingQuestion(sessionId)).toBeUndefined();
  });
});

describe("external Goal waiting on background work", () => {
  const identity = (run: { goal: { goalId?: string; revision?: number } }) => ({
    goalId: run.goal.goalId,
    revision: run.goal.revision,
  });
  const tool = (toolName: string, agentId?: string): StreamEvent =>
    ({
      type: "tool_use_start",
      toolCall: { id: toolName, toolName, arguments: {} },
      ...(agentId ? { agentId } : {}),
    }) as StreamEvent;

  test("running work parks the Goal only when the model calls wait_for_background", () => {
    const run = goals.start(sessionId, "边等边做")!;
    expect(goals.backgroundTurnEnd(run, false)).toBe("none");
    expect(goals.backgroundTurnEnd(run, true)).toBe("remind");
    expect(goals.waitForBackground(sessionId, identity(run), true)).toMatchObject({ ok: true });
    expect(goals.backgroundTurnEnd(run, true)).toBe("park");
    // The request covers one turn only.
    expect(goals.backgroundTurnEnd(run, true)).toBe("remind");
    expect(goals.backgroundTurnEnd(undefined, true)).toBe("none");
  });

  test("an idle turn after the reminder is parked by the host; a working turn is not", () => {
    const run = goals.start(sessionId, "边等边做")!;
    expect(goals.backgroundTurnEnd(run, true)).toBe("remind");
    goals.observeTurnEvent(run, tool("Bash"));
    expect(goals.backgroundTurnEnd(run, true)).toBe("remind");
    // Goal controls and a sub-agent's calls are not this turn's own work.
    goals.observeTurnEvent(run, tool("mcp__codeshell_tools__get_goal"));
    goals.observeTurnEvent(run, tool("Read", "child-1"));
    expect(goals.backgroundTurnEnd(run, true)).toBe("park");
    // Work that finished meanwhile needs no park.
    expect(goals.backgroundTurnEnd(run, true)).toBe("remind");
    expect(goals.backgroundTurnEnd(run, false)).toBe("none");
  });

  test("wait_for_background refuses a stale identity or a wait with nothing running", () => {
    const run = goals.start(sessionId, "边等边做")!;
    expect(
      goals.waitForBackground(sessionId, { goalId: "other", revision: 1 }, true),
    ).toMatchObject({ ok: false });
    expect(goals.waitForBackground(sessionId, identity(run), false)).toMatchObject({ ok: false });
    expect(goals.backgroundTurnEnd(run, true)).toBe("remind");
  });

  test("the continuation names running work only after a reminder decision", () => {
    const run = goals.start(sessionId, "边等边做")!;
    const tasks = [{ kind: "job", label: "迁移脚本评审" }];
    expect(goals.continuation(run, tasks)).not.toContain("<background_work>");
    goals.backgroundTurnEnd(run, true);
    const text = goals.continuation(run, tasks);
    expect(text).toContain("继续处理尚未完成的目标。");
    expect(text).toContain('Background work is still running: "迁移脚本评审"');
    expect(text).toContain("do not poll");
    expect(text).toContain("mcp__codeshell_tools__wait_for_background");
    expect(text).toContain("<codeshell_goal>");
    expect(goals.continuation(run)).toContain("Background work is still running.");
  });

  test("a repeated identical reply still pauses the Goal (stop-block cap)", () => {
    const run = goals.start(sessionId, { objective: "空转", maxStopBlocks: 2 })!;
    expect(goals.afterTurn(run, 1, "还在等")).toBe(true);
    expect(goals.afterTurn(run, 1, "还在等")).toBe(true);
    expect(goals.afterTurn(run, 1, "还在等")).toBe(false);
    expect(goals.get(sessionId).paused).toBe(true);
  });
});

describe("external Goal questions", () => {
  const ask = (run: { goal: { goalId?: string; revision?: number } }, extra: object) =>
    goals.waitForUser(sessionId, {
      goalId: run.goal.goalId,
      revision: run.goal.revision,
      ...extra,
    });

  test("flat options are shorthand for one structured question, without repeating the text", () => {
    const run = goals.start(sessionId, "发布")!;
    expect(
      ask(run, {
        question: "发 rc 还是正式版？",
        options: [" rc ", "正式版"],
        default: "正式版",
        level: "preference",
      }),
    ).toMatchObject({ ok: true });
    const event = events.at(-1) as Extract<StreamEvent, { type: "goal_progress" }>;
    expect(event).toMatchObject({
      waitingForUser: "发 rc 还是正式版？",
      waitingForUserDetail: {
        level: "preference",
        questions: [
          {
            id: "q1",
            question: "发 rc 还是正式版？",
            options: [{ label: "rc" }, { label: "正式版" }],
            default: "正式版",
          },
        ],
      },
      gaps: "等待你的回复",
    });
    expect(event.gaps).not.toContain("发 rc");
  });

  test("a bare question stays valid and defaults to a preference", () => {
    const run = goals.start(sessionId, "发布")!;
    expect(ask(run, { question: "继续吗？" })).toMatchObject({ ok: true });
    expect(events.at(-1)).toMatchObject({
      waitingForUser: "继续吗？",
      waitingForUserDetail: { level: "preference" },
    });
  });

  test("a consent question is one yes/no question: options and default are dropped", () => {
    const run = goals.start(sessionId, "部署")!;
    const yesNo = { options: [{ label: "是" }, { label: "否" }] };
    expect(
      ask(run, {
        level: "consent",
        questions: [
          { id: "a", question: "写入密钥吗？", ...yesNo },
          { id: "b", question: "顺便发布吗？", ...yesNo },
        ],
      }),
    ).toMatchObject({ ok: false, message: expect.stringContaining("single question") });
    expect(
      ask(run, {
        question: "要把新密钥写入生产服务器吗？",
        level: "consent",
        options: ["写入", "不写"],
        default: "写入",
      }),
    ).toMatchObject({ ok: true });
    const detail = (events.at(-1) as Extract<StreamEvent, { type: "goal_progress" }>)
      .waitingForUserDetail;
    expect(detail).toEqual({ level: "consent" });
  });

  test("malformed questions are refused with a reason and publish nothing", () => {
    const run = goals.start(sessionId, "发布")!;
    const before = events.length;
    for (const bad of [
      { question: "长".repeat(601) },
      { question: "继续吗？", level: "urgent" },
      { question: "继续吗？", options: "是" },
      { question: "继续吗？", options: ["1", "2", "3", "4", "5"] },
      { question: "继续吗？", options: ["只有一个"] },
      { question: "继续吗？", options: ["是", "x".repeat(81)] },
      { question: "继续吗？", options: ["是", "是"] },
      { question: "继续吗？", options: ["是", "否"], default: "都行" },
      { question: "继续吗？", default: "是" },
      { options: ["是", "否"] },
      {
        question: "继续吗？",
        options: ["是", "否"],
        questions: [{ id: "a", question: "继续吗？", options: [{ label: "是" }, { label: "否" }] }],
      },
    ]) {
      const result = ask(run, bad);
      expect(result.ok).toBe(false);
      expect(result.message.length).toBeGreaterThan(10);
    }
    expect(events).toHaveLength(before);
    expect(goals.pendingQuestion(sessionId)).toBeUndefined();
    expect(goals.afterTurn(run, 1, "继续")).toBe(true);
  });

  test("only one question is accepted per turn", () => {
    const run = goals.start(sessionId, "发布")!;
    expect(ask(run, { question: "第一个问题？" })).toMatchObject({ ok: true });
    const before = events.length;
    const second = ask(run, { question: "第二个问题？" });
    expect(second.ok).toBe(false);
    expect(second.message).toContain("only one");
    expect(events).toHaveLength(before);
    expect(goals.pendingQuestion(sessionId)).toBe("第一个问题？");
  });

  test("a question the user already saw is not asked again", () => {
    const first = goals.start(sessionId, "发布")!;
    expect(ask(first, { question: "发 rc 还是正式版？" })).toMatchObject({ ok: true });
    goals.afterTurn(first, 1, "已提问");
    goals.end(first);
    // Any real user message closes it, whether it answered or moved on.
    goals.userReplied(sessionId);
    const next = goals.start(sessionId)!;
    const before = events.length;
    const repeat = ask(next, { question: "  发 RC  还是正式版？ " });
    expect(repeat.ok).toBe(false);
    expect(repeat.message).toContain("Do not ask it again");
    expect(events).toHaveLength(before);
    expect(goals.afterTurn(next, 1, "继续")).toBe(true);
    expect(ask(next, { question: "另一个新问题？" })).toMatchObject({ ok: true });
  });

  test("an unanswered question is kept; a different one does not replace it", () => {
    const first = goals.start(sessionId, "发布")!;
    expect(ask(first, { question: "发 rc 还是正式版？", options: ["rc", "正式版"] })).toMatchObject(
      {
        ok: true,
      },
    );
    goals.afterTurn(first, 1, "已提问");
    goals.end(first);
    // A resume (not a user message) starts another run with the question open.
    const resumed = goals.start(sessionId)!;
    const other = ask(resumed, { question: "要不要顺便发公告？" });
    expect(other.ok).toBe(false);
    expect(other.message).toContain("发 rc 还是正式版？");
    expect(goals.pendingQuestion(sessionId)).toBe("发 rc 还是正式版？");
    expect(events.at(-1)).toMatchObject({
      waitingForUser: "发 rc 还是正式版？",
      waitingForUserDetail: {
        questions: [
          { question: "发 rc 还是正式版？", options: [{ label: "rc" }, { label: "正式版" }] },
        ],
      },
    });
    // The Goal keeps waiting on the original instead of continuing by itself.
    expect(goals.afterTurn(resumed, 1, "仍在等")).toBe(false);
    expect(goals.get(sessionId).paused).toBe(false);
  });

  test("the prompt grades decisions and never asks for the question twice", () => {
    const run = goals.start(sessionId, "发布")!;
    const text = goals.instruction(run);
    expect(text).not.toContain("ask it in your reply");
    expect(text).toContain("do not repeat the question in your reply text");
    expect(text).toContain("Only one wait_for_user call is accepted per turn");
    expect(text).toContain("L0, a reversible engineering or quality decision");
    expect(text).toContain("state the default you are taking, proceed with it");
    expect(text).toContain('you must ask with level "consent"');
    expect(text).toContain("is not consent");
    // The old blanket rule stopped every outward action, including L1 ones.
    expect(text).not.toContain("publishing or other outward actions), do not take that step");
    expect(text).toContain("mcp__codeshell_tools__wait_for_background");
    expect(text).toContain("inferred from documentation and unverified");
  });
});

describe("a paused external Goal and the next message", () => {
  /** What the recorder persists when a run ends on a limit. */
  const closeRunOnLimit = () =>
    manager.updateSessionState(sessionId, { lastCompletionKind: "limit_stop" });

  test("a limit pause says which limit, as a structured reason", () => {
    const run = goals.start(sessionId, { objective: "跑满预算", maxTurns: 1 })!;
    expect(goals.afterTurn(run, 10, "第一轮")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "goal_progress", pauseReason: "turn_limit" });
    expect(run.limited).toBe(true);
    goals.end(run);

    const timed = new ExternalRuntimeGoals(
      (_sessionId, event) => events.push(event),
      () => now,
    );
    goals.update(sessionId, {
      paused: false,
      expectedGoalId: run.goal.goalId!,
      expectedRevision: 2,
    });
    const second = timed.start(sessionId)!;
    timed.pause(second, "time_budget");
    expect(events.at(-1)).toMatchObject({
      type: "goal_progress",
      pauseReason: "time_budget",
      gaps: "达到本轮时间预算；目标已暂停，可继续。",
    });
  });

  test("a message into a limit-paused Goal resumes it with a fresh run", () => {
    const run = goals.start(sessionId, { objective: "继续优化", maxTurns: 1 })!;
    expect(goals.afterTurn(run, 10, "第一轮")).toBe(false);
    goals.end(run);
    closeRunOnLimit();
    expect(goals.get(sessionId)).toMatchObject({ paused: true, revision: 2 });
    events.length = 0;

    // An automatic continuation never resumes a pause.
    expect(goals.start(sessionId)).toBeUndefined();
    expect(events).toEqual([]);

    const resumed = goals.start(sessionId, undefined, false, true)!;
    expect(resumed.goal).toMatchObject({ goalId: run.goal.goalId, revision: 3 });
    expect(resumed.turns).toBe(0);
    expect(resumed.maxTurns).toBe(1);
    expect(manager.readSessionState(sessionId)?.goalLifecycle).toMatchObject({
      phase: "active",
      revision: 3,
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "goal_updated",
        goalId: run.goal.goalId,
        revision: 3,
        paused: false,
      }),
    ]);
  });

  test("a restarted app still resumes a limit pause from the persisted run outcome", () => {
    const run = goals.start(sessionId, { objective: "重启后继续", maxTurns: 1 })!;
    goals.afterTurn(run, 10, "第一轮");
    goals.end(run);
    closeRunOnLimit();
    const restarted = new ExternalRuntimeGoals(() => {});
    expect(restarted.start(sessionId, undefined, false, true)?.goal.goalId).toBe(run.goal.goalId);
  });

  test("the pause reason is persisted, so a restart needs no run outcome to tell the pauses apart", () => {
    // Stopped for lack of progress: blocked, and resumed by the next message.
    const run = goals.start(sessionId, { objective: "没有进展", maxStopBlocks: 1 })!;
    goals.afterTurn(run, 10, "同样的回复");
    goals.afterTurn(run, 10, "同样的回复");
    goals.end(run);
    expect(manager.readSessionState(sessionId)?.goalLifecycle).toMatchObject({
      phase: "paused",
      pauseReason: "no_progress",
    });
    // No `lastCompletionKind` was recorded: only the lifecycle says why.
    const restarted = new ExternalRuntimeGoals(() => {});
    expect(restarted.get(sessionId)).toMatchObject({ paused: true, pauseReason: "no_progress" });
    expect(restarted.start(sessionId)).toBeUndefined();
    const resumed = restarted.start(sessionId, undefined, false, true)!;
    expect(resumed.goal.goalId).toBe(run.goal.goalId);
    expect(restarted.get(sessionId)).not.toHaveProperty("pauseReason");
    restarted.end(resumed);

    // The user's own pause survives a restart as theirs, even beside a stale
    // `limit_stop` run outcome.
    restarted.update(sessionId, {
      paused: true,
      expectedGoalId: resumed.goal.goalId!,
      expectedRevision: resumed.goal.revision!,
    });
    closeRunOnLimit();
    expect(manager.readSessionState(sessionId)?.goalLifecycle).toMatchObject({
      phase: "paused",
      pauseReason: "user",
    });
    const again = new ExternalRuntimeGoals(() => {});
    expect(again.start(sessionId, undefined, false, true)).toBeUndefined();
    expect(again.get(sessionId)).toMatchObject({ paused: true, pauseReason: "user" });
  });

  test("editing a limit-paused Goal keeps why it paused", () => {
    const run = goals.start(sessionId, { objective: "改目标", maxTurns: 1 })!;
    goals.afterTurn(run, 10, "第一轮");
    goals.end(run);
    goals.update(sessionId, {
      objective: "改过的目标",
      expectedGoalId: run.goal.goalId!,
      expectedRevision: 2,
    });
    expect(manager.readSessionState(sessionId)?.goalLifecycle).toMatchObject({
      phase: "paused",
      revision: 3,
      pauseReason: "turn_limit",
    });
  });

  test("a paused record from before the reason was persisted behaves as it did", () => {
    const run = goals.start(sessionId, "旧记录")!;
    goals.end(run);
    // What an older build wrote: paused, no reason.
    manager.updateActiveGoal(sessionId, { paused: true });
    expect(manager.readSessionState(sessionId)?.goalLifecycle).not.toHaveProperty("pauseReason");
    const restarted = new ExternalRuntimeGoals(() => {});
    expect(restarted.get(sessionId)).not.toHaveProperty("pauseReason");
    expect(restarted.start(sessionId, undefined, false, true)).toBeUndefined();
    closeRunOnLimit();
    expect(restarted.start(sessionId, undefined, false, true)?.goal.goalId).toBe(run.goal.goalId);
  });

  test("a pause the user asked for is not resumed by a message", () => {
    const run = goals.start(sessionId, "用户暂停")!;
    goals.pause(run, "user_stop", true);
    expect(events.at(-1)).toMatchObject({ type: "goal_progress", pauseReason: "user_stop" });
    goals.end(run);
    expect(goals.start(sessionId, undefined, false, true)).toBeUndefined();
    expect(goals.get(sessionId)).toMatchObject({ paused: true });

    // Paused by the user after a limit pause was resumed: still the user's pause.
    const other = "external-goal-user-pause";
    manager.create("/tmp/project", "codex/test", "codex", other, null, "desktop");
    const limited = goals.start(other, { objective: "先限额后手动", maxTurns: 1 })!;
    goals.afterTurn(limited, 10, "第一轮");
    goals.end(limited);
    manager.updateSessionState(other, { lastCompletionKind: "limit_stop" });
    const again = goals.start(other, undefined, false, true)!;
    goals.end(again);
    goals.update(other, {
      paused: true,
      expectedGoalId: again.goal.goalId!,
      expectedRevision: again.goal.revision!,
    });
    expect(goals.start(other, undefined, false, true)).toBeUndefined();
  });

  test("a turn that opts out of the Goal leaves a limit pause in place", () => {
    const run = goals.start(sessionId, { objective: "不被打断", maxTurns: 1 })!;
    goals.afterTurn(run, 10, "第一轮");
    goals.end(run);
    closeRunOnLimit();
    expect(goals.start(sessionId, undefined, true, true)).toBeUndefined();
    expect(goals.get(sessionId)).toMatchObject({ paused: true });
  });
});

describe("what stops an external Goal by itself", () => {
  /** One provider turn: `tools` work tool calls, then the host's turn-end bookkeeping. */
  const turn = (run: NonNullable<ReturnType<typeof goals.start>>, output: string, tools = 1) => {
    for (let call = 0; call < tools; call++)
      goals.observeTurnEvent(run, {
        type: "tool_use_start",
        toolCall: { id: `t${call}`, toolName: "Bash", args: {} },
      });
    goals.backgroundTurnEnd(run, false);
    return goals.afterTurn(run, 10, output);
  };

  test("no timer and no turn count pauses a Goal that keeps making progress", () => {
    const run = goals.start(sessionId, "等 CI 然后发版")!;
    expect(run.timeBudgetMs).toBeUndefined();
    expect(run.maxTurns).toBeUndefined();
    for (let round = 1; round <= 40; round++) {
      now += 10 * 60_000;
      expect(turn(run, `第 ${round} 轮的进展`)).toBe(true);
    }
    expect(goals.get(sessionId)).toMatchObject({ paused: false });
    expect(goals.remainingTime(run)).toBe(Number.POSITIVE_INFINITY);
    expect(events.some((event) => event.type === "goal_updated")).toBe(false);
    // Without a cap there is no "approaching the limit" to announce.
    expect(
      events.some((event) => event.type === "goal_progress" && event.status !== "not_met"),
    ).toBe(false);
  });

  test("several turns in a row without any work stop it as no progress", () => {
    const run = goals.start(sessionId, "不要空转")!;
    expect(turn(run, "我再想想", 0)).toBe(true);
    expect(turn(run, "还在想", 0)).toBe(true);
    // A turn that did work resets the count.
    expect(turn(run, "跑了一次测试", 1)).toBe(true);
    expect(turn(run, "等一下", 0)).toBe(true);
    expect(turn(run, "再等一下", 0)).toBe(true);
    expect(turn(run, "还是等", 0)).toBe(false);
    expect(goals.get(sessionId)).toMatchObject({ paused: true });
    expect(events.at(-1)).toMatchObject({ type: "goal_progress", pauseReason: "no_progress" });
  });

  test("a turn that parks on background work is a wait, not a turn without progress", () => {
    const run = goals.start(sessionId, "等后台")!;
    for (let round = 0; round < 5; round++) {
      goals.backgroundTurnEnd(run, true);
      expect(goals.afterTurn(run, 10, `等待中 ${round}`, true)).toBe(true);
    }
    expect(goals.get(sessionId)).toMatchObject({ paused: false });
  });

  test("a budget the user set still stops it, named as that budget", () => {
    const timed = goals.start(sessionId, { objective: "限时", timeBudgetMs: 1_000 })!;
    now += 1_000;
    expect(turn(timed, "做了一些")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "goal_progress", pauseReason: "time_budget" });
    goals.end(timed);

    const other = "external-goal-token-budget";
    manager.create("/tmp/project", "codex/test", "codex", other, null, "desktop");
    const metered = goals.start(other, { objective: "限额", tokenBudget: 15, maxTurns: 9 })!;
    expect(turn(metered, "第一轮")).toBe(true);
    expect(turn(metered, "第二轮")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "goal_progress", pauseReason: "token_budget" });
  });

  test("the prompt no longer promises a time or turn allowance that does not exist", () => {
    const open = goals.instruction(goals.start(sessionId, "无预算")!);
    expect(open).not.toContain(" ms");
    expect(open).not.toContain("provider turns");
    expect(open).toContain("does not stop this goal on a timer");
    const other = "external-goal-explicit-budget";
    manager.create("/tmp/project", "codex/test", "codex", other, null, "desktop");
    const budgeted = goals.instruction(
      goals.start(other, { objective: "有预算", timeBudgetMs: 60_000, tokenBudget: 500 })!,
    );
    expect(budgeted).toContain("60000 ms");
    expect(budgeted).toContain("500 tokens");
  });

  test("resuming a Goal whose run is already going changes nothing", () => {
    const run = goals.start(sessionId, "别重复恢复")!;
    events.length = 0;
    const result = goals.update(sessionId, {
      paused: false,
      expectedGoalId: run.goal.goalId!,
      expectedRevision: run.goal.revision!,
    });
    expect(result).toMatchObject({ updated: false, paused: false, revision: 1 });
    expect(events).toEqual([]);
    expect(goals.isCurrent(run)).toBe(true);
  });
});

import { createFakeEngine } from "../testing/create-fake-engine.js";
import { describe, expect, it } from "bun:test";
import type { EngineResult } from "../engine/engine.js";
import type { GoalConfig } from "../goal/lifecycle.js";
import { ChatSession } from "./chat-session.js";

function result(sessionId: string): EngineResult {
  return {
    text: "ok",
    reason: "completed",
    sessionId,
    turnCount: 1,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ChatSession.enqueueGoalResumeTurn", () => {
  it("forwards the Goal version guard through the queued turn", async () => {
    const goalContinuation = { goalId: "original", revision: 4 };
    const runs: unknown[] = [];
    const engine = createFakeEngine({
      async run(_task: string, opts: unknown) {
        runs.push(opts);
        return result("guarded");
      },
    });
    const session = new ChatSession({ id: "guarded", engine });
    await session.enqueueTurn("continue", { goalContinuation });
    expect(runs).toEqual([expect.objectContaining({ goalContinuation, goal: undefined })]);
  });
  it("forwards a one-turn request to disable Goal mode", async () => {
    const runs: Array<{ disableGoal?: boolean }> = [];
    const engine = createFakeEngine({
      async run(_task: string, opts: { disableGoal?: boolean }): Promise<EngineResult> {
        runs.push(opts);
        return result("standalone-loop-session");
      },
    });
    const session = new ChatSession({ id: "standalone-loop-session", engine });

    await session.enqueueTurn("standalone loop", { disableGoal: true });

    expect(runs).toEqual([expect.objectContaining({ disableGoal: true })]);
  });

  it("runs one synthetic turn when the matching resumed goal is idle", async () => {
    const goal: GoalConfig = {
      objective: "finish the audit",
      goalId: "goal-idle",
      revision: 4,
    };
    const runs: Array<{ task: string; injected?: boolean }> = [];
    const engine = createFakeEngine({
      getGoal: () => goal,
      async run(
        task: string,
        opts: { injected?: boolean; goal?: string | GoalConfig },
      ): Promise<EngineResult> {
        runs.push({ task, injected: opts.injected });
        return result("idle-session");
      },
    });
    const session = new ChatSession({ id: "idle-session", engine });

    await expect(session.enqueueGoalResumeTurn(goal)).resolves.toBe(true);
    await Promise.resolve();

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ injected: true });
    expect(runs[0]?.task).toContain("读取当前持久目标");
    expect(runs[0]?.task).not.toContain(goal.objective);
    expect(session.queueDepth()).toBe(0);
    expect(session.isBusy()).toBe(false);
  });

  it("runs the queued resume against the latest revision after a same-goal edit", async () => {
    const resumedGoal: GoalConfig = {
      objective: "original objective",
      goalId: "goal-edited-while-queued",
      revision: 8,
    };
    let currentGoal: GoalConfig | undefined = resumedGoal;
    const blockerStarted = deferred();
    const releaseBlocker = deferred();
    const tasks: string[] = [];
    const engine = createFakeEngine({
      getGoal: () => currentGoal,
      async run(task: string): Promise<EngineResult> {
        tasks.push(task);
        if (task === "blocker") {
          blockerStarted.resolve();
          await releaseBlocker.promise;
        }
        return result("queued-edit-session");
      },
    });
    const session = new ChatSession({ id: "queued-edit-session", engine });
    const blocker = session.enqueueTurn("blocker", {});
    await blockerStarted.promise;

    const resume = session.enqueueGoalResumeTurn(resumedGoal);
    currentGoal = { ...resumedGoal, objective: "edited objective", revision: 9 };
    releaseBlocker.resolve();

    await blocker;
    await expect(resume).resolves.toBe(true);
    expect(tasks).toHaveLength(2);
    expect(tasks[1]).not.toContain("original objective");
  });

  it("coalesces resume-pause-resume while another turn owns the session", async () => {
    const resumedGoal: GoalConfig = {
      objective: "finish once",
      goalId: "goal-resume-coalesced",
      revision: 2,
    };
    let currentGoal: GoalConfig | undefined = resumedGoal;
    const blockerStarted = deferred();
    const releaseBlocker = deferred();
    const tasks: string[] = [];
    const engine = createFakeEngine({
      getGoal: () => currentGoal,
      async run(task: string): Promise<EngineResult> {
        tasks.push(task);
        if (task === "blocker") {
          blockerStarted.resolve();
          await releaseBlocker.promise;
        }
        return result("resume-coalesced-session");
      },
    });
    const session = new ChatSession({ id: "resume-coalesced-session", engine });
    const blocker = session.enqueueTurn("blocker", {});
    await blockerStarted.promise;

    const firstResume = session.enqueueGoalResumeTurn(resumedGoal);
    currentGoal = { ...resumedGoal, paused: true, revision: 3 };
    currentGoal = { ...resumedGoal, revision: 4 };
    const secondResume = session.enqueueGoalResumeTurn(currentGoal);

    await expect(firstResume).resolves.toBe(false);
    releaseBlocker.resolve();
    await blocker;
    await expect(secondResume).resolves.toBe(true);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toBe("blocker");
    expect(tasks[1]).toContain("读取当前持久目标");
  });

  for (const invalidation of ["pause", "delete"] as const) {
    it(`skips a queued resume after a later goal ${invalidation}`, async () => {
      const resumedGoal: GoalConfig = {
        objective: "original objective",
        goalId: "goal-queued",
        revision: 8,
      };
      let currentGoal: GoalConfig | undefined = resumedGoal;
      const blockerStarted = deferred();
      const releaseBlocker = deferred();
      const tasks: string[] = [];
      const engine = createFakeEngine({
        getGoal: () => currentGoal,
        async run(task: string): Promise<EngineResult> {
          tasks.push(task);
          if (task === "blocker") {
            blockerStarted.resolve();
            await releaseBlocker.promise;
          }
          return result("queued-session");
        },
      });
      const session = new ChatSession({ id: "queued-session", engine });
      const blocker = session.enqueueTurn("blocker", {});
      await blockerStarted.promise;

      const resume = session.enqueueGoalResumeTurn(resumedGoal);
      currentGoal =
        invalidation === "pause" ? { ...resumedGoal, paused: true, revision: 9 } : undefined;
      releaseBlocker.resolve();

      await blocker;
      await expect(resume).resolves.toBe(false);
      expect(tasks).toEqual(["blocker"]);
      expect(session.queueDepth()).toBe(0);
    });
  }
});

for (const change of [
  "edit",
  "pause",
  "delete",
  "replace",
  "stop",
  "stop-then-user",
  "waiting",
  "repeat",
  "supersede",
] as const) {
  it(`startup hold retries once, fenced by ${change}`, async () => {
    const original: GoalConfig = { goalId: "held-goal", revision: 1, objective: "before" };
    let current: GoalConfig | undefined = original;
    let runs = 0;
    let successor: Promise<boolean> | undefined;
    let userTurn: Promise<EngineResult> | undefined;
    const engine = createFakeEngine({
      getGoal: () => current,
      isGoalContinuationBlocked: () => change === "waiting",
      async run(): Promise<EngineResult> {
        runs++;
        if (runs === 1 || change === "repeat") {
          current = { ...original, revision: runs + 1, objective: "latest" };
          if (change === "pause") current.paused = true;
          if (change === "delete") current = undefined;
          if (change === "replace") current.goalId = "replacement";
          if (change === "stop") session.cancel();
          if (change === "stop-then-user") {
            session.cancel();
            userTurn = session.enqueueTurn("actual user", { trigger: "user" });
          }
          if (change === "supersede") successor = session.enqueueGoalResumeTurn(current!);
          return {
            ...result("held"),
            turnCount: 0,
            reason: "aborted_streaming",
            goalContinuationHeld: { retryGoalId: original.goalId },
          };
        }
        expect(current?.objective).toBe("latest");
        return result("held");
      },
    });
    const session = new ChatSession({ id: "held", engine });
    await expect(session.enqueueGoalResumeTurn(original)).resolves.toBe(change === "edit");
    if (successor) await expect(successor).resolves.toBe(true);
    if (userTurn) await userTurn;
    await session.settled;
    expect(runs).toBe(
      change === "edit" ||
        change === "repeat" ||
        change === "supersede" ||
        change === "stop-then-user"
        ? 2
        : 1,
    );
    expect(session.queueDepth()).toBe(0);
    if (change === "stop") expect(session.wasCancelledSinceLastTurn()).toBe(true);
  });
}

it("an injected host run cannot lift Stop even when labeled user", async () => {
  const session = new ChatSession({
    id: "stop",
    engine: createFakeEngine({
      async run() {
        return result("stop");
      },
    }),
  });
  session.cancel();
  await session.enqueueTurn("host reminder", { injected: true, trigger: "user" });
  expect(session.wasCancelledSinceLastTurn()).toBe(true);
  await session.enqueueTurn("host message", { trigger: "host_message" });
  expect(session.wasCancelledSinceLastTurn()).toBe(true);
  await session.enqueueTurn("actual user", { trigger: "user" });
  expect(session.wasCancelledSinceLastTurn()).toBe(false);
});

it("does not replay a held client message receipt", async () => {
  let runs = 0;
  const session = new ChatSession({
    id: "receipt",
    engine: createFakeEngine({
      getGoal: () => ({ goalId: "goal", revision: 2, objective: "latest" }),
      async run() {
        runs++;
        return {
          ...result("receipt"),
          turnCount: 0,
          reason: "aborted_streaming" as const,
          goalContinuationHeld: { retryGoalId: "goal" },
        };
      },
    }),
  });
  const held = await session.enqueueTurn("host input", {
    injected: true,
    trigger: "host_message",
    clientMessageId: "receipt-id",
  });
  expect(held.goalContinuationHeld).toEqual({ retryGoalId: "goal" });
  expect(runs).toBe(1);
});

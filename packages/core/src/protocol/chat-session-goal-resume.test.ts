import { describe, expect, it } from "bun:test";
import type { Engine, EngineResult } from "../engine/engine.js";
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
  it("runs one synthetic turn when the matching resumed goal is idle", async () => {
    const goal: GoalConfig = {
      objective: "finish the audit",
      goalId: "goal-idle",
      revision: 4,
    };
    const runs: Array<{ task: string; injected?: boolean }> = [];
    const engine = {
      getGoal: () => goal,
      async run(
        task: string,
        opts: { injected?: boolean; goal?: string | GoalConfig },
      ): Promise<EngineResult> {
        runs.push({ task, injected: opts.injected });
        return result("idle-session");
      },
    } as unknown as Engine;
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
    const engine = {
      getGoal: () => currentGoal,
      async run(task: string): Promise<EngineResult> {
        tasks.push(task);
        if (task === "blocker") {
          blockerStarted.resolve();
          await releaseBlocker.promise;
        }
        return result("queued-edit-session");
      },
    } as unknown as Engine;
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
    const engine = {
      getGoal: () => currentGoal,
      async run(task: string): Promise<EngineResult> {
        tasks.push(task);
        if (task === "blocker") {
          blockerStarted.resolve();
          await releaseBlocker.promise;
        }
        return result("resume-coalesced-session");
      },
    } as unknown as Engine;
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
      const engine = {
        getGoal: () => currentGoal,
        async run(task: string): Promise<EngineResult> {
          tasks.push(task);
          if (task === "blocker") {
            blockerStarted.resolve();
            await releaseBlocker.promise;
          }
          return result("queued-session");
        },
      } as unknown as Engine;
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

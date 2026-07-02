import { describe, it, expect } from "bun:test";
import { createGoalStopHook, type GoalJudgeLLM } from "./goal-stop-hook.js";
import type { LLMResponse } from "../types.js";

/**
 * GoalStopHook three-state judge. Covers the branches the review flagged as
 * uncovered: the three verdict states, the `waiting`-with-empty-task-list guard
 * (a hallucinated waiting must NOT silently abandon the goal), the per-run
 * verdict cache, and that the run's abort signal reaches the judge call.
 *
 * The hook reads running background work from the process-local registries via
 * listRunningBackgroundWork(sessionId). These tests use a sessionId with no
 * registered work, so that list is always empty — which is exactly the
 * condition the empty-list guard cares about.
 */

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** A judge LLM that returns a fixed text and records how it was called. */
function fakeJudge(
  text: string,
): GoalJudgeLLM & {
  calls: number;
  lastSignal?: AbortSignal;
  lastUserContent?: string;
  lastMaxTokens?: number;
  lastReasoning?: unknown;
} {
  const j = {
    calls: 0,
    lastSignal: undefined as AbortSignal | undefined,
    lastUserContent: undefined as string | undefined,
    lastMaxTokens: undefined as number | undefined,
    lastReasoning: undefined as unknown,
    async createMessage(opts: {
      signal?: AbortSignal;
      messages?: { role: string; content: string }[];
      maxTokens?: number;
      reasoning?: unknown;
    }): Promise<LLMResponse> {
      j.calls += 1;
      j.lastSignal = opts.signal;
      j.lastUserContent = opts.messages?.[0]?.content;
      j.lastMaxTokens = opts.maxTokens;
      j.lastReasoning = opts.reasoning;
      return { text, toolCalls: [] };
    },
  };
  return j;
}

const SID = "test-session-no-bg-work";

describe("createGoalStopHook — three-state judge", () => {
  it("met:true → allows stop, no continueSession, surfaces met verdict", async () => {
    const hook = createGoalStopHook({
      goal: "ship it",
      llm: fakeJudge('{"met": true, "waiting": false, "gaps": ""}'),
      log: noopLog,
    });
    const res = await hook({ eventName: "on_stop", data: { sessionId: SID, finalText: "done" } });
    expect(res.continueSession).toBeUndefined();
    expect((res.data?.goalVerdict as { met: boolean }).met).toBe(true);
  });

  it("met:true fires onMet exactly once", async () => {
    let metCalls = 0;
    const hook = createGoalStopHook({
      goal: "ship it",
      llm: fakeJudge('{"met": true, "waiting": false, "gaps": ""}'),
      log: noopLog,
      onMet: () => {
        metCalls += 1;
      },
    });
    await hook({ eventName: "on_stop", data: { sessionId: SID, finalText: "done" } });
    expect(metCalls).toBe(1);
  });

  it("not_met → continueSession with the gap surfaced", async () => {
    const hook = createGoalStopHook({
      goal: "ship it",
      llm: fakeJudge('{"met": false, "waiting": false, "gaps": "tests still failing"}'),
      log: noopLog,
    });
    const res = await hook({ eventName: "on_stop", data: { sessionId: SID, finalText: "wip" } });
    expect(res.continueSession).toBe(true);
    expect(res.messages?.[0]).toContain("tests still failing");
  });

  it("goal cleared mid-run → allows stop WITHOUT calling the judge", async () => {
    // The persisted goal was cleared (user hit 清除) while a long-lived run was
    // still going. The hook's frozen `opts.goal` copy would otherwise keep
    // judging not_met forever. isGoalActive lets it re-check the live goal each
    // turn: cleared → allow stop, skip the LLM entirely.
    const judge = fakeJudge('{"met": false, "waiting": false, "gaps": "still going"}');
    const hook = createGoalStopHook({
      goal: "ship it",
      llm: judge,
      log: noopLog,
      isGoalActive: () => false, // goal was cleared on disk
    });
    const res = await hook({ eventName: "on_stop", data: { sessionId: SID, finalText: "wip" } });
    expect(res.continueSession).toBeUndefined(); // allow stop, no re-block
    expect(judge.calls).toBe(0); // never paid for the judge
  });

  it("goal still active (isGoalActive true) → judges normally", async () => {
    const judge = fakeJudge('{"met": false, "waiting": false, "gaps": "tests failing"}');
    const hook = createGoalStopHook({
      goal: "ship it",
      llm: judge,
      log: noopLog,
      isGoalActive: () => true,
    });
    const res = await hook({ eventName: "on_stop", data: { sessionId: SID, finalText: "wip" } });
    expect(res.continueSession).toBe(true);
    expect(judge.calls).toBe(1);
  });

  it("GUARD: waiting:true with NO running background work falls through to not_met", async () => {
    // The session has no registered background work, so honoring `waiting` would
    // abandon the goal with nothing left to wake it. Must continueSession instead.
    const hook = createGoalStopHook({
      goal: "download the file",
      llm: fakeJudge('{"met": false, "waiting": true, "gaps": "waiting for download"}'),
      log: noopLog,
    });
    const res = await hook({ eventName: "on_stop", data: { sessionId: SID, finalText: "started" } });
    expect(res.continueSession).toBe(true);
  });

  it("judge failure does NOT allow stop (P0)", async () => {
    const throwing: GoalJudgeLLM = {
      async createMessage(): Promise<LLMResponse> {
        throw new Error("judge boom");
      },
    };
    const hook = createGoalStopHook({ goal: "ship it", llm: throwing, log: noopLog });
    const res = await hook({ eventName: "on_stop", data: { sessionId: SID, finalText: "x" } });
    expect(res.continueSession).toBe(true);
  });

  it("unparseable judge output does NOT allow stop (P0)", async () => {
    const hook = createGoalStopHook({
      goal: "ship it",
      llm: fakeJudge("I think it's probably fine?"),
      log: noopLog,
    });
    const res = await hook({ eventName: "on_stop", data: { sessionId: SID, finalText: "x" } });
    expect(res.continueSession).toBe(true);
  });

  it("judge call turns reasoning OFF (aux call — no thinking tokens to spend/truncate)", async () => {
    const judge = fakeJudge('{"met": false, "waiting": false, "gaps": "x"}');
    const hook = createGoalStopHook({ goal: "ship it", llm: judge, log: noopLog });
    await hook({ eventName: "on_stop", data: { sessionId: SID, finalText: "x" } });
    expect(judge.lastReasoning).toEqual({ mode: "off" });
  });

  it("judge call requests a maxTokens large enough to survive a reasoning model", async () => {
    const judge = fakeJudge('{"met": false, "waiting": false, "gaps": "x"}');
    const hook = createGoalStopHook({ goal: "ship it", llm: judge, log: noopLog });
    await hook({ eventName: "on_stop", data: { sessionId: SID, finalText: "x" } });
    // 400 was too small once reasoning tokens shared the budget (real bug:
    // deepseek burned ~256 on reasoning, JSON got truncated). Give real headroom.
    expect(judge.lastMaxTokens).toBeGreaterThanOrEqual(1500);
  });

  it("unparseable judge output logs stopReason + response preview for diagnosis", async () => {
    const logs: { msg: string; data?: Record<string, unknown> }[] = [];
    const spyLog = {
      info: () => {},
      warn: (msg: string, data?: Record<string, unknown>) => logs.push({ msg, data }),
      error: () => {},
    };
    const truncated: GoalJudgeLLM = {
      async createMessage(): Promise<LLMResponse> {
        // A truncated judge reply: prose, no closing brace — extractJson fails.
        return { text: '{"met": false, "waiting": fal', toolCalls: [], stopReason: "length" };
      },
    };
    const hook = createGoalStopHook({ goal: "ship it", llm: truncated, log: spyLog });
    await hook({ eventName: "on_stop", data: { sessionId: SID, finalText: "x" } });
    const rec = logs.find((l) => l.msg === "goal_stop.unparseable");
    expect(rec).toBeDefined();
    expect(rec!.data?.stopReason).toBe("length");
    expect(String(rec!.data?.preview)).toContain('{"met"');
  });

  it("judge prompt includes the goal-set time when the goal carries setAtMs", async () => {
    const judge = fakeJudge('{"met": false, "waiting": false, "gaps": "x"}');
    const setAt = Date.UTC(2026, 6, 1, 14, 0, 0); // 2026-07-01 14:00 UTC
    const hook = createGoalStopHook({
      goal: { objective: "做到3点后就不再做了", setAtMs: setAt },
      llm: judge,
      log: noopLog,
    });
    await hook({ eventName: "on_stop", data: { sessionId: SID, finalText: "x" } });
    // The prompt must anchor the relative deadline to WHEN the goal was set, so
    // a "3点" written at 14:00 today isn't misread as tomorrow's 3点 once the
    // clock passes it. We don't pin the exact locale rendering — just that the
    // set-time label is present.
    expect(judge.lastUserContent).toContain("目标设定于");
    expect(judge.lastUserContent).toContain("2026-07-01");
  });

  it("judge prompt omits the goal-set time when setAtMs is absent (back-compat)", async () => {
    const judge = fakeJudge('{"met": false, "waiting": false, "gaps": "x"}');
    const hook = createGoalStopHook({ goal: { objective: "ship it" }, llm: judge, log: noopLog });
    await hook({ eventName: "on_stop", data: { sessionId: SID, finalText: "x" } });
    expect(judge.lastUserContent).not.toContain("目标设定于");
  });

  it("no goal → allows stop without calling the judge", async () => {
    const judge = fakeJudge('{"met": true, "waiting": false, "gaps": ""}');
    const hook = createGoalStopHook({ goal: "", llm: judge, log: noopLog });
    const res = await hook({ eventName: "on_stop", data: { sessionId: SID, finalText: "x" } });
    expect(res).toEqual({});
    expect(judge.calls).toBe(0);
  });

  it("verdict cache: identical (goal, finalText, tasks) reuses the verdict, no second LLM call", async () => {
    const judge = fakeJudge('{"met": false, "waiting": false, "gaps": "more work"}');
    const hook = createGoalStopHook({ goal: "ship it", llm: judge, log: noopLog });
    const data = { sessionId: SID, finalText: "same output" };
    const first = await hook({ eventName: "on_stop", data });
    const second = await hook({ eventName: "on_stop", data: { ...data } });
    expect(judge.calls).toBe(1); // second served from cache
    expect(second).toEqual(first);
  });

  it("verdict cache misses when finalText changes", async () => {
    const judge = fakeJudge('{"met": false, "waiting": false, "gaps": "more work"}');
    const hook = createGoalStopHook({ goal: "ship it", llm: judge, log: noopLog });
    await hook({ eventName: "on_stop", data: { sessionId: SID, finalText: "output A" } });
    await hook({ eventName: "on_stop", data: { sessionId: SID, finalText: "output B" } });
    expect(judge.calls).toBe(2);
  });

  it("passes the run's abort signal through to the judge call", async () => {
    const judge = fakeJudge('{"met": false, "waiting": false, "gaps": "x"}');
    const hook = createGoalStopHook({ goal: "ship it", llm: judge, log: noopLog });
    const ac = new AbortController();
    await hook({
      eventName: "on_stop",
      data: { sessionId: SID, finalText: "x", signal: ac.signal },
    });
    expect(judge.lastSignal).toBe(ac.signal);
  });

  it("feeds the current time (injected `now`) into the judge prompt", async () => {
    const judge = fakeJudge('{"met": false, "waiting": false, "gaps": "x"}');
    const fixed = new Date("2026-07-01T04:11:00Z");
    const hook = createGoalStopHook({
      goal: "干到 12:00 停",
      llm: judge,
      log: noopLog,
      now: () => fixed,
    });
    await hook({ eventName: "on_stop", data: { sessionId: SID, finalText: "x" } });
    // The judge must see a current-time line so it can reason about a deadline.
    expect(judge.lastUserContent).toContain("当前时间");
    // The UTC anchor is always present regardless of the runner's timezone.
    expect(judge.lastUserContent).toContain("2026-07-01T04:11:00.000Z");
  });

  it("cache re-judges when the clock advances to the next minute", async () => {
    // Same goal + same finalText + same (empty) tasks — the ONLY thing that
    // changes is the wall clock. A time-blind cache would replay the stale
    // verdict and a deadline would never fire; the minute bucket must bust it.
    let t = new Date("2026-07-01T11:59:30Z");
    const judge = fakeJudge('{"met": false, "waiting": false, "gaps": "more"}');
    const hook = createGoalStopHook({
      goal: "干到 12:00 停",
      llm: judge,
      log: noopLog,
      now: () => t,
    });
    const data = { sessionId: SID, finalText: "same" };
    await hook({ eventName: "on_stop", data });
    // Same minute → served from cache, no second call.
    t = new Date("2026-07-01T11:59:55Z");
    await hook({ eventName: "on_stop", data: { ...data } });
    expect(judge.calls).toBe(1);
    // Clock crosses into the next minute → cache miss, judge re-runs.
    t = new Date("2026-07-01T12:00:05Z");
    await hook({ eventName: "on_stop", data: { ...data } });
    expect(judge.calls).toBe(2);
  });
});

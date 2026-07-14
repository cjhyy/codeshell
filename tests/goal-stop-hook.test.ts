import { describe, it, expect, beforeEach } from "bun:test";
import {
  createGoalStopHook as createGoalStopHookImpl,
  type GoalStopHookOptions,
} from "../packages/core/src/hooks/goal-stop-hook.ts";
import type { HookContext } from "../packages/core/src/hooks/events.ts";
import { backgroundJobRegistry } from "../packages/core/src/tool-system/builtin/background-jobs.ts";

function ctx(data: Record<string, unknown>): HookContext {
  return { eventName: "on_stop", data };
}

/** Minimal LLM fake: returns a scripted text for createMessage. */
function fakeLLM(text: string, onCall?: (opts: unknown) => void) {
  return {
    createMessage: async (opts: unknown) => {
      onCall?.(opts);
      return { text, toolCalls: [] };
    },
  };
}

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function createGoalStopHook(
  opts: Omit<GoalStopHookOptions, "getJudgeContext"> &
    Partial<Pick<GoalStopHookOptions, "getJudgeContext">>,
) {
  return createGoalStopHookImpl({
    getJudgeContext: () => ({
      toolResults: [],
      progress: { turnCount: 1, stopRound: 1, elapsedMs: 0, tokensUsed: 0 },
    }),
    ...opts,
  });
}

describe("createGoalStopHook", () => {
  it("allows stop (no-op) when no goal is in ctx.data", async () => {
    let called = false;
    const llm = fakeLLM("{}", () => {
      called = true;
    });
    const hook = createGoalStopHook({ llm, log: silentLog });
    const res = await hook(ctx({ finalText: "done" }));
    expect(res.continueSession).toBeUndefined();
    // No goal → never even calls the model.
    expect(called).toBe(false);
  });

  it("allows stop when the judge says the goal is met", async () => {
    const llm = fakeLLM(JSON.stringify({ met: true, waiting: false, gaps: "" }));
    const hook = createGoalStopHook({ llm, log: silentLog });
    const res = await hook(ctx({ goal: "ship it", finalText: "shipped" }));
    expect(res.continueSession).toBeUndefined();
  });

  it("blocks stop and injects gaps when the judge says not met", async () => {
    const llm = fakeLLM(
      JSON.stringify({ met: false, waiting: false, gaps: "tests still failing" }),
    );
    const hook = createGoalStopHook({ llm, log: silentLog });
    const res = await hook(ctx({ goal: "make tests pass", finalText: "I think it's fine" }));
    expect(res.continueSession).toBe(true);
    expect(res.messages).toBeDefined();
    expect(res.messages!.join("\n")).toContain("tests still failing");
  });

  // The structured verdict rides in result.data.goalVerdict so the turn loop
  // can emit a goal_progress stream event WITHOUT re-running the judge LLM —
  // the same {met, gaps} the hook already computed is surfaced to the UI.
  it("surfaces the structured verdict in data.goalVerdict (not met)", async () => {
    const llm = fakeLLM(
      JSON.stringify({ met: false, waiting: false, gaps: "tests still failing" }),
    );
    const hook = createGoalStopHook({ llm, log: silentLog });
    const res = await hook(ctx({ goal: "make tests pass", finalText: "fine" }));
    expect(res.data?.goalVerdict).toEqual({ met: false, gaps: "tests still failing" });
  });

  it("surfaces the structured verdict in data.goalVerdict (met)", async () => {
    const llm = fakeLLM(JSON.stringify({ met: true, waiting: false, gaps: "" }));
    const hook = createGoalStopHook({ llm, log: silentLog });
    const res = await hook(ctx({ goal: "ship it", finalText: "shipped" }));
    expect(res.data?.goalVerdict).toEqual({ met: true, gaps: "" });
  });

  it("tolerates JSON wrapped in a code fence", async () => {
    const llm = fakeLLM(
      '```json\n{"met": false, "waiting": false, "gaps": "deploy step missing"}\n```',
    );
    const hook = createGoalStopHook({ llm, log: silentLog });
    const res = await hook(ctx({ goal: "deploy", finalText: "built" }));
    expect(res.continueSession).toBe(true);
    expect(res.messages!.join("\n")).toContain("deploy step missing");
  });

  // P0 behavior change (Goal mode redesign, 2026-06-02): a failing judge
  // must NOT silently allow the stop — in unattended runs that means the
  // goal silently fails. The hook now nudges to continue; the turn-loop
  // run-scoped budget guardrail is the real backstop against infinite loops.
  it("continues (does NOT silently allow stop) when the judge call throws", async () => {
    const llm = {
      createMessage: async () => {
        throw new Error("boom");
      },
    };
    let warned = false;
    const hook = createGoalStopHook({
      llm,
      log: {
        ...silentLog,
        warn: () => {
          warned = true;
        },
      },
    });
    const res = await hook(ctx({ goal: "x", finalText: "y" }));
    expect(res.continueSession).toBe(true);
    expect(res.messages).toBeDefined();
    expect(warned).toBe(true);
  });

  it("continues (does NOT silently allow stop) when the judge returns unparseable text", async () => {
    const llm = fakeLLM("I have no idea, sorry.");
    const hook = createGoalStopHook({ llm, log: silentLog });
    const res = await hook(ctx({ goal: "x", finalText: "y" }));
    expect(res.continueSession).toBe(true);
    expect(res.messages).toBeDefined();
  });

  it("accepts a GoalConfig object goal (not just a string)", async () => {
    const llm = fakeLLM(JSON.stringify({ met: true, waiting: false, gaps: "" }));
    const hook = createGoalStopHook({ llm, log: silentLog });
    const res = await hook(
      ctx({ goal: { objective: "ship it", tokenBudget: 1000 }, finalText: "shipped" }),
    );
    expect(res.continueSession).toBeUndefined();
  });

  it("treats empty/whitespace goal as no goal", async () => {
    let called = false;
    const llm = fakeLLM("{}", () => {
      called = true;
    });
    const hook = createGoalStopHook({ llm, log: silentLog });
    const res = await hook(ctx({ goal: "   ", finalText: "done" }));
    expect(res.continueSession).toBeUndefined();
    expect(called).toBe(false);
  });
});
// The mechanical short-circuit is gone (2026-06-17 unified-background-work
// redesign). The judge now sees the running background tasks and returns a
// three-state verdict; `waiting:true` allows the stop without pushing. These
// tests pin the three branches and that the task list reaches the judge.
describe("createGoalStopHook three-state verdict (waiting)", () => {
  beforeEach(() => backgroundJobRegistry.reset());

  it("allows the stop (no push) when the judge returns waiting:true", async () => {
    backgroundJobRegistry.start("video-1", "s1", "生成视频中:a cat");
    const llm = fakeLLM(JSON.stringify({ met: false, waiting: true, gaps: "等视频渲染完" }));
    const hook = createGoalStopHook({ goal: "生成 2 个视频", llm, log: silentLog });
    const res = await hook(ctx({ goal: "生成 2 个视频", sessionId: "s1", finalText: "已提交" }));
    // waiting → allow stop (no continueSession); the completion notification
    // wakes the idle session, which re-judges the goal.
    expect(res.continueSession).toBeUndefined();
    // Verdict still surfaced (not met) so the UI shows progress.
    expect((res.data as { goalVerdict?: { met: boolean } })?.goalVerdict?.met).toBe(false);
  });

  it("feeds the running background tasks into the judge prompt", async () => {
    backgroundJobRegistry.start("video-1", "s1", "生成视频中:a dog");
    let seen = "";
    const llm = {
      createMessage: async (opts: any) => {
        seen = opts.messages?.[0]?.content ?? "";
        return { text: JSON.stringify({ met: false, waiting: true, gaps: "" }), toolCalls: [] };
      },
    };
    const hook = createGoalStopHook({ goal: "g", llm, log: silentLog });
    await hook(ctx({ goal: "g", sessionId: "s1", finalText: "x" }));
    expect(seen).toContain("生成视频中:a dog");
    expect(seen).toContain("untrustedBackgroundTasks");
  });

  it("judges normally (not_met → continue) when the judge does NOT set waiting", async () => {
    backgroundJobRegistry.start("video-1", "s1", "生成视频中:a fish");
    // Even with a background task running, if the judge decides there's still
    // active work (waiting:false), it pushes — the decision is the LLM's.
    const llm = fakeLLM(JSON.stringify({ met: false, waiting: false, gaps: "还要写脚本" }));
    const hook = createGoalStopHook({ goal: "g", llm, log: silentLog });
    const res = await hook(ctx({ goal: "g", sessionId: "s1", finalText: "x" }));
    expect(res.continueSession).toBe(true);
    expect(res.messages!.join("\n")).toContain("还要写脚本");
  });

  it("continues safely when an old judge omits the required `waiting` field", async () => {
    const llm = fakeLLM(JSON.stringify({ met: false, gaps: "还差一个" }));
    const hook = createGoalStopHook({ goal: "g", llm, log: silentLog });
    const res = await hook(ctx({ goal: "g", sessionId: "s1", finalText: "x" }));
    expect(res.continueSession).toBe(true);
  });

  it("ignores waiting:true when NO background work is actually running (anti-hallucination guard)", async () => {
    // No backgroundJobRegistry.start — nothing is running. A judge that returns
    // waiting:true here would, if honored, silently abandon the goal (nothing
    // ever wakes the session). The guard falls through to continueSession.
    const llm = fakeLLM(JSON.stringify({ met: false, waiting: true, gaps: "等一个不存在的任务" }));
    const hook = createGoalStopHook({ goal: "g", llm, log: silentLog });
    const res = await hook(ctx({ goal: "g", sessionId: "s1", finalText: "x" }));
    expect(res.continueSession).toBe(true);
  });
});

describe("createGoalStopHook onMet callback (persistent goal clear)", () => {
  it("calls onMet exactly when the judge returns met", async () => {
    let mets = 0;
    const llm = fakeLLM(JSON.stringify({ met: true, waiting: false, gaps: "" }));
    const hook = createGoalStopHook({ goal: "g", llm, log: silentLog, onMet: () => mets++ });
    const res = await hook(ctx({ goal: "g", sessionId: "s1", finalText: "done" }));
    expect((res.data as { goalVerdict?: { met: boolean } })?.goalVerdict?.met).toBe(true);
    expect(mets).toBe(1);
  });

  it("does NOT call onMet when the goal is not met", async () => {
    let mets = 0;
    const llm = fakeLLM(JSON.stringify({ met: false, waiting: false, gaps: "还差" }));
    const hook = createGoalStopHook({ goal: "g", llm, log: silentLog, onMet: () => mets++ });
    await hook(ctx({ goal: "g", sessionId: "s1", finalText: "x" }));
    expect(mets).toBe(0);
  });

  it("a throwing onMet fails closed instead of reporting an unpersisted met verdict", async () => {
    const llm = fakeLLM(JSON.stringify({ met: true, waiting: false, gaps: "" }));
    const hook = createGoalStopHook({
      goal: "g",
      llm,
      log: silentLog,
      onMet: () => {
        throw new Error("boom");
      },
    });
    const res = await hook(ctx({ goal: "g", sessionId: "s1", finalText: "done" }));
    expect(
      (res.data as { goalVerdict?: { met: boolean } } | undefined)?.goalVerdict,
    ).toBeUndefined();
    expect(res.continueSession).toBe(true);
    expect(res.messages?.[0]).toContain("持久化完成状态失败");
  });
});

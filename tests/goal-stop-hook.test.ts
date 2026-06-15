import { describe, it, expect, beforeEach } from "bun:test";
import { createGoalStopHook } from "../packages/core/src/hooks/goal-stop-hook.ts";
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
    const llm = fakeLLM(JSON.stringify({ met: true, gaps: "" }));
    const hook = createGoalStopHook({ llm, log: silentLog });
    const res = await hook(
      ctx({ goal: "ship it", finalText: "shipped" }),
    );
    expect(res.continueSession).toBeUndefined();
  });

  it("blocks stop and injects gaps when the judge says not met", async () => {
    const llm = fakeLLM(
      JSON.stringify({ met: false, gaps: "tests still failing" }),
    );
    const hook = createGoalStopHook({ llm, log: silentLog });
    const res = await hook(
      ctx({ goal: "make tests pass", finalText: "I think it's fine" }),
    );
    expect(res.continueSession).toBe(true);
    expect(res.messages).toBeDefined();
    expect(res.messages!.join("\n")).toContain("tests still failing");
  });

  // The structured verdict rides in result.data.goalVerdict so the turn loop
  // can emit a goal_progress stream event WITHOUT re-running the judge LLM —
  // the same {met, gaps} the hook already computed is surfaced to the UI.
  it("surfaces the structured verdict in data.goalVerdict (not met)", async () => {
    const llm = fakeLLM(
      JSON.stringify({ met: false, gaps: "tests still failing" }),
    );
    const hook = createGoalStopHook({ llm, log: silentLog });
    const res = await hook(
      ctx({ goal: "make tests pass", finalText: "fine" }),
    );
    expect(res.data?.goalVerdict).toEqual({ met: false, gaps: "tests still failing" });
  });

  it("surfaces the structured verdict in data.goalVerdict (met)", async () => {
    const llm = fakeLLM(JSON.stringify({ met: true, gaps: "" }));
    const hook = createGoalStopHook({ llm, log: silentLog });
    const res = await hook(ctx({ goal: "ship it", finalText: "shipped" }));
    expect(res.data?.goalVerdict).toEqual({ met: true, gaps: "" });
  });

  it("tolerates JSON wrapped in prose / code fences", async () => {
    const llm = fakeLLM(
      'Sure!\n```json\n{"met": false, "gaps": "deploy step missing"}\n```\n',
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
      log: { ...silentLog, warn: () => { warned = true; } },
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
    const llm = fakeLLM(JSON.stringify({ met: true, gaps: "" }));
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

describe("createGoalStopHook background-job short-circuit", () => {
  beforeEach(() => backgroundJobRegistry.reset());

  it("allows the stop WITHOUT calling the judge when the session has a running background job", async () => {
    backgroundJobRegistry.start("video-1", "s1");
    let called = false;
    const llm = fakeLLM(JSON.stringify({ met: false, gaps: "video not done" }), () => {
      called = true;
    });
    const hook = createGoalStopHook({ goal: "生成 2 个视频", llm, log: silentLog });
    const res = await hook(ctx({ goal: "生成 2 个视频", sessionId: "s1", finalText: "已提交" }));
    // Stop is allowed (no continueSession) — the engine wait-loop parks the
    // turn until the video notification lands. The expensive judge must NOT run.
    expect(res.continueSession).toBeUndefined();
    expect(called).toBe(false);
  });

  it("judges normally when the running job belongs to a DIFFERENT session", async () => {
    backgroundJobRegistry.start("video-1", "other-session");
    const llm = fakeLLM(JSON.stringify({ met: false, gaps: "还差一个" }));
    const hook = createGoalStopHook({ goal: "g", llm, log: silentLog });
    const res = await hook(ctx({ goal: "g", sessionId: "s1", finalText: "x" }));
    expect(res.continueSession).toBe(true);
  });
});

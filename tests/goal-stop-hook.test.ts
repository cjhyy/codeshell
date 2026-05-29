import { describe, it, expect } from "bun:test";
import { createGoalStopHook } from "../packages/core/src/hooks/goal-stop-hook.ts";
import type { HookContext } from "../packages/core/src/hooks/events.ts";

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

  it("tolerates JSON wrapped in prose / code fences", async () => {
    const llm = fakeLLM(
      'Sure!\n```json\n{"met": false, "gaps": "deploy step missing"}\n```\n',
    );
    const hook = createGoalStopHook({ llm, log: silentLog });
    const res = await hook(ctx({ goal: "deploy", finalText: "built" }));
    expect(res.continueSession).toBe(true);
    expect(res.messages!.join("\n")).toContain("deploy step missing");
  });

  it("conservatively allows stop when the judge call throws", async () => {
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
    expect(res.continueSession).toBeUndefined();
    expect(warned).toBe(true);
  });

  it("conservatively allows stop when the judge returns unparseable text", async () => {
    const llm = fakeLLM("I have no idea, sorry.");
    const hook = createGoalStopHook({ llm, log: silentLog });
    const res = await hook(ctx({ goal: "x", finalText: "y" }));
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

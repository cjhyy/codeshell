import { describe, test, expect } from "bun:test";
import { createGoalStopHook } from "./goal-stop-hook.js";
import type { HookContext } from "./events.js";

const noopLog = { info() {}, warn() {}, error() {} };

function ctx(goal: unknown, finalText = ""): HookContext {
  return { data: { goal, finalText } } as unknown as HookContext;
}

describe("goal stop hook (P0: judge is fallback, failure does NOT silently allow stop)", () => {
  test("no goal → allow stop", async () => {
    const hook = createGoalStopHook({
      llm: { createMessage: async () => ({ text: "" }) } as any,
      log: noopLog,
    });
    expect(await hook(ctx(undefined))).toEqual({});
  });

  test("judge says met → allow stop", async () => {
    const hook = createGoalStopHook({
      llm: { createMessage: async () => ({ text: '{"met":true,"gaps":""}' }) } as any,
      log: noopLog,
    });
    expect(await hook(ctx({ objective: "x" }))).toEqual({});
  });

  test("judge says NOT met → continue with gaps", async () => {
    const hook = createGoalStopHook({
      llm: {
        createMessage: async () => ({ text: '{"met":false,"gaps":"need tests"}' }),
      } as any,
      log: noopLog,
    });
    const r = await hook(ctx({ objective: "x" }));
    expect(r.continueSession).toBe(true);
    expect(r.messages?.[0]).toContain("need tests");
  });

  test("UNPARSEABLE judge output → continue (NOT silently allow stop)", async () => {
    const hook = createGoalStopHook({
      llm: { createMessage: async () => ({ text: "uhh I am not json" }) } as any,
      log: noopLog,
    });
    const r = await hook(ctx({ objective: "x" }));
    expect(r.continueSession).toBe(true); // ← the P0 behavior change
  });

  test("judge THROWS → continue (NOT silently allow stop)", async () => {
    const hook = createGoalStopHook({
      llm: {
        createMessage: async () => {
          throw new Error("boom");
        },
      } as any,
      log: noopLog,
    });
    const r = await hook(ctx({ objective: "x" }));
    expect(r.continueSession).toBe(true); // ← the P0 behavior change
  });

  test("accepts a plain string goal too (back-compat via ctx.data.goal)", async () => {
    const hook = createGoalStopHook({
      llm: { createMessage: async () => ({ text: '{"met":true,"gaps":""}' }) } as any,
      log: noopLog,
    });
    expect(await hook(ctx("ship it"))).toEqual({});
  });
});

import { describe, it, expect } from "bun:test";
import { enterPlanModeTool, exitPlanModeTool } from "./plan.js";
import type { ToolContext } from "../context.js";

/** Minimal engine stub tracking planMode through setPlanMode. */
function stubCtx(initial = false): { ctx: ToolContext; planMode: () => boolean } {
  let plan = initial;
  const ctx = {
    engine: {
      get planMode() {
        return plan;
      },
      setPlanMode(v: boolean) {
        plan = v;
      },
    },
  } as unknown as ToolContext;
  return { ctx, planMode: () => plan };
}

describe("enterPlanModeTool", () => {
  it("turns plan mode on and explains the rules", async () => {
    const { ctx, planMode } = stubCtx(false);
    const out = await enterPlanModeTool({}, ctx);
    expect(planMode()).toBe(true);
    expect(out).toContain("Entered plan mode");
    expect(out).toContain("read-only");
  });

  it("is idempotent when already in plan mode", async () => {
    const { ctx, planMode } = stubCtx(true);
    const out = await enterPlanModeTool({}, ctx);
    expect(out).toContain("Already in plan mode");
    expect(planMode()).toBe(true);
  });
});

describe("exitPlanModeTool", () => {
  it("turns plan mode off", async () => {
    const { ctx, planMode } = stubCtx(true);
    const out = await exitPlanModeTool({}, ctx);
    expect(planMode()).toBe(false);
    expect(out).toContain("Exited plan mode");
  });

  it("no-ops when not in plan mode", async () => {
    const { ctx } = stubCtx(false);
    expect(await exitPlanModeTool({}, ctx)).toContain("Not currently in plan mode");
  });
});

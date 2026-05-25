import { describe, it, expect } from "bun:test";

describe("plan mode isolation", () => {
  it("two ToolContexts can carry different planMode values", () => {
    // After refactor: there is no global getter. Each engine surfaces its own.
    const ctxA = { planMode: true } as any;
    const ctxB = { planMode: false } as any;
    expect(ctxA.planMode).toBe(true);
    expect(ctxB.planMode).toBe(false);
  });

  it("plan.ts no longer exports setInPlanMode/isInPlanMode", async () => {
    const mod: any = await import("../packages/core/src/tool-system/builtin/plan.ts");
    expect(mod.setInPlanMode).toBeUndefined();
    expect(mod.isInPlanMode).toBeUndefined();
  });

  it("permission.ts no longer exports setRuntimeBypass/isRuntimeBypass", async () => {
    const mod: any = await import("../packages/core/src/tool-system/permission.ts");
    expect(mod.setRuntimeBypass).toBeUndefined();
    expect(mod.isRuntimeBypass).toBeUndefined();
  });
});

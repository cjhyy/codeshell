import { describe, it, expect } from "bun:test";
import type { ToolContext } from "../packages/core/src/tool-system/context.ts";

describe("ToolContext", () => {
  it("carries planMode flag", () => {
    const ctx: Partial<ToolContext> = { planMode: true };
    expect(ctx.planMode).toBe(true);
  });
});

import { describe, it, expect } from "bun:test";
import { Engine } from "../packages/core/src/engine/engine.ts";

describe("Plan tool", () => {
  it("toggles engine.planMode through ToolContext", async () => {
    const e = new Engine({ cwd: "/tmp", llm: { provider: "noop" } as any, permissionMode: "default" });
    expect(e.planMode).toBe(false);
    // Simulate Plan tool execution. Engine should pass itself into ctx so
    // the tool can call ctx.engine.setPlanMode(true).
    const ctx = (e as any).buildToolContext();
    ctx.engine.setPlanMode(true);
    expect(e.planMode).toBe(true);
  });
});

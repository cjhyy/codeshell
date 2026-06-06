import { describe, it, expect } from "bun:test";
import { Engine } from "./engine.js";

const baseLlm = { provider: "openai", model: "gpt-5", apiKey: "test-key" } as any;

describe("Engine.getPermissionRules (TODO 5.1)", () => {
  it("returns the effective rule set including preset defaults", () => {
    const engine = new Engine({ llm: baseLlm });
    const rules = engine.getPermissionRules();
    expect(Array.isArray(rules)).toBe(true);
    // The MemorySave/MemoryDelete dream-scope allow rules are always pushed.
    expect(rules.some((r) => r.tool === "MemorySave" && r.decision === "allow")).toBe(true);
  });

  it("adds Write/Edit allow rules in acceptEdits mode", () => {
    const engine = new Engine({ llm: baseLlm, permissionMode: "acceptEdits" });
    const rules = engine.getPermissionRules();
    expect(rules.some((r) => r.tool === "Write" && r.decision === "allow")).toBe(true);
    expect(rules.some((r) => r.tool === "Edit" && r.decision === "allow")).toBe(true);
  });

  it("adds a Bash allow rule in bypassPermissions mode", () => {
    const engine = new Engine({ llm: baseLlm, permissionMode: "bypassPermissions" });
    const rules = engine.getPermissionRules();
    expect(rules.some((r) => r.tool === "Bash" && r.decision === "allow")).toBe(true);
  });
});

import { describe, test, expect } from "bun:test";
import { reasoningControlFor } from "./reasoning-control.js";

describe("reasoningControlFor", () => {
  test("gpt-5.5 (openai-effort, disabledEffort none) → effort control without minimal, with xhigh", () => {
    const c = reasoningControlFor("openai", "gpt-5.5");
    expect(c.kind).toBe("effort");
    if (c.kind === "effort") {
      expect(c.options).not.toContain("minimal");
      expect(c.options).toContain("xhigh");
      expect(c.options).toContain("high");
    }
  });

  test("gpt-5 (openai-effort, default) → effort control with minimal..high, no xhigh", () => {
    const c = reasoningControlFor("openai", "gpt-5");
    expect(c.kind).toBe("effort");
    if (c.kind === "effort") {
      expect(c.options).toContain("minimal");
      expect(c.options).not.toContain("xhigh");
    }
  });

  test("deepseek-v4 (deepseek-thinking) → toggle control", () => {
    expect(reasoningControlFor("deepseek", "deepseek-v4").kind).toBe("toggle");
  });

  test("glm-4.6 (zai deepseek-thinking) → toggle control", () => {
    expect(reasoningControlFor("zai", "glm-4.6").kind).toBe("toggle");
  });

  test("claude-opus-4-5 (anthropic-budget) → budget control with min", () => {
    const c = reasoningControlFor("anthropic", "claude-opus-4-5");
    expect(c.kind).toBe("budget");
    if (c.kind === "budget") expect(c.min).toBeGreaterThanOrEqual(1024);
  });

  test("claude 4.6+ (anthropic-adaptive) → adaptive control", () => {
    expect(reasoningControlFor("anthropic", "claude-sonnet-4-6").kind).toBe("adaptive");
  });

  test("openrouter model → effort control (minimal..high, no xhigh)", () => {
    const c = reasoningControlFor("openrouter", "openai/gpt-5");
    expect(c.kind).toBe("effort");
    if (c.kind === "effort") expect(c.options).not.toContain("xhigh");
  });

  test("a non-reasoning model (deepseek-reasoner / claude-3) → none", () => {
    expect(reasoningControlFor("deepseek", "deepseek-reasoner").kind).toBe("none");
  });
});

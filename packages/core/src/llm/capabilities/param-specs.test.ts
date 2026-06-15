/**
 * paramSpecsFromCapability — project the existing capability knowledge
 * (rules.ts, the single source of truth) into catalog ParamSpec[], so the
 * unified catalog reuses that vetted knowledge instead of re-hand-writing it.
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §4.
 */
import { describe, test, expect } from "bun:test";
import { paramSpecsFromCapability } from "./param-specs.js";

describe("paramSpecsFromCapability", () => {
  test("gpt-5.5 → reasoning enum [low,medium,high,xhigh] on reasoning_effort", () => {
    const specs = paramSpecsFromCapability("openai", "gpt-5.5");
    const r = specs.find((s) => s.name === "reasoning");
    expect(r?.control).toBe("enum");
    expect(r?.options).toEqual(["low", "medium", "high", "xhigh"]);
    expect(r?.wire?.field).toBe("reasoning_effort");
  });

  test("gpt-5 (o-series shape) → reasoning enum minimal..high", () => {
    const r = paramSpecsFromCapability("openai", "gpt-5").find((s) => s.name === "reasoning");
    expect(r?.control).toBe("enum");
    expect(r?.options).toEqual(["minimal", "low", "medium", "high"]);
  });

  test("gpt-4o → no reasoning param (non-reasoning model)", () => {
    const specs = paramSpecsFromCapability("openai", "gpt-4o");
    expect(specs.find((s) => s.name === "reasoning")).toBeUndefined();
  });

  test("claude-opus-4-5 → reasoning number (budget) on thinking.budget_tokens", () => {
    const r = paramSpecsFromCapability("anthropic", "claude-opus-4-5").find((s) => s.name === "reasoning");
    expect(r?.control).toBe("number");
    expect(r?.min).toBe(1024);
    expect(r?.wire?.field).toBe("thinking.budget_tokens");
  });

  test("claude-opus-4-7 (adaptive) → no reasoning control (adaptive, nothing to set)", () => {
    const r = paramSpecsFromCapability("anthropic", "claude-opus-4-7").find((s) => s.name === "reasoning");
    expect(r).toBeUndefined();
  });

  test("deepseek-v4 → reasoning toggle", () => {
    const r = paramSpecsFromCapability("deepseek", "deepseek-v4").find((s) => s.name === "reasoning");
    expect(r?.control).toBe("toggle");
  });

  test("magistral → reasoning enum [high] only", () => {
    const r = paramSpecsFromCapability("mistral", "magistral-medium").find((s) => s.name === "reasoning");
    expect(r?.control).toBe("enum");
    expect(r?.options).toEqual(["high"]);
  });

  test("every reasoning spec carries a doc string (for tool injection)", () => {
    const r = paramSpecsFromCapability("openai", "gpt-5.5").find((s) => s.name === "reasoning");
    expect(typeof r?.doc).toBe("string");
    expect(r!.doc!.length).toBeGreaterThan(0);
  });
});

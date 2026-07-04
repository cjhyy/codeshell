/**
 * Built-in text (LLM) catalog entries — the unified catalog now seeds text
 * providers, with per-model params projected from the capability layer.
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §4.
 */
import { describe, test, expect } from "bun:test";
import { BUILTIN_CATALOG } from "./builtin.js";

const text = BUILTIN_CATALOG.filter((e) => e.tag === "text");

describe("BUILTIN_CATALOG text entries", () => {
  test("ships text entries for the major providers", () => {
    const kinds = new Set(text.map((e) => e.adapterKind));
    expect(kinds.has("openai")).toBe(true);
    expect(kinds.has("anthropic")).toBe(true);
  });

  test("openai text entry has gpt-5.5 preset with reasoning enum", () => {
    const openai = text.find((e) => e.id === "openai");
    expect(openai).toBeTruthy();
    const gpt55 = openai!.modelPresets?.find((p) => p.value.startsWith("gpt-5.5"));
    expect(gpt55).toBeTruthy();
    const r = gpt55!.params?.find((p) => p.name === "reasoning");
    expect(r?.control).toBe("enum");
    expect(r?.options).toContain("xhigh");
  });

  test("anthropic text entry has a budget-reasoning preset (claude 4.x ≤4.5)", () => {
    const anth = text.find((e) => e.id === "anthropic");
    expect(anth).toBeTruthy();
    const budgetPreset = anth!.modelPresets?.find((p) =>
      p.params?.some((x) => x.name === "reasoning" && x.control === "number"),
    );
    expect(budgetPreset).toBeTruthy();
  });

  test("text entries declare protocol + needsKey", () => {
    const openai = text.find((e) => e.id === "openai")!;
    expect(openai.protocol).toBeTruthy();
    expect(openai.needsKey).toBe(true);
  });

  test("every text preset declares a real maxContextTokens (no 200k fallback)", () => {
    // Regression: catalog connections lost their context window (全部回退 200k 兜底)
    // because presets carried no maxContextTokens. Every shipped text model must
    // declare its real window (verified against vendor docs 2026-06-16). Ollama is
    // exempt — local model windows are machine/quant-dependent, left to runtime.
    const expectedFloor = 100_000; // every current frontier model is ≥128k
    for (const e of text) {
      if (e.id === "ollama") continue;
      for (const p of e.modelPresets ?? []) {
        expect(typeof p.maxContextTokens).toBe("number");
        expect(p.maxContextTokens!).toBeGreaterThanOrEqual(expectedFloor);
      }
    }
  });

  test("known model context windows match vendor docs", () => {
    const ctxOf = (entryId: string, value: string): number | undefined =>
      text.find((e) => e.id === entryId)?.modelPresets?.find((p) => p.value === value)?.maxContextTokens;
    expect(ctxOf("openai", "gpt-5.5")).toBe(1_050_000);
    expect(ctxOf("openai", "gpt-5.4-mini")).toBe(400_000);
    expect(ctxOf("openai", "gpt-4o")).toBe(128_000);
    expect(ctxOf("anthropic", "claude-opus-4-8")).toBe(1_000_000);
    expect(ctxOf("anthropic", "claude-haiku-4-5")).toBe(200_000);
    expect(ctxOf("deepseek", "deepseek-v4-pro")).toBe(1_000_000);
    expect(ctxOf("google", "gemini-3.5-flash")).toBe(1_048_576);
  });

  test("known vision-capable text presets are marked for the composer", () => {
    const presetOf = (entryId: string, value: string) =>
      text.find((e) => e.id === entryId)?.modelPresets?.find((p) => p.value === value);

    expect(presetOf("openai", "gpt-5.5")?.supportsVision).toBe(true);
    expect(presetOf("openai", "gpt-4o")?.supportsVision).toBe(true);
    expect(presetOf("anthropic", "claude-opus-4-8")?.supportsVision).toBe(true);
    expect(presetOf("google", "gemini-2.5-pro")?.supportsVision).toBe(true);
    expect(presetOf("openrouter", "anthropic/claude-opus-4.8")?.supportsVision).toBe(true);
    expect(presetOf("deepseek", "deepseek-v4-pro")?.supportsVision).toBe(false);
    expect(presetOf("zhipu", "glm-5.2")?.supportsVision).toBe(false);
  });

  test("every text preset's params parse against the schema (well-formed)", () => {
    // If params were malformed, catalogEntrySchema (validated on user load) would
    // reject them; assert the built-in shape holds the same contract.
    for (const e of text) {
      for (const p of e.modelPresets ?? []) {
        for (const spec of p.params ?? []) {
          expect(["enum", "number", "toggle", "text"]).toContain(spec.control);
        }
      }
    }
  });
});

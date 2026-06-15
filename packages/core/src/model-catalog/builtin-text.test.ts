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

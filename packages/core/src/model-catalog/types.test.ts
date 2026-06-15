/**
 * Unified catalog schema — text tag + ParamSpec + per-model params.
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §3.
 */
import { describe, test, expect } from "bun:test";
import { catalogEntrySchema, paramSpecSchema } from "./types.js";

describe("catalogEntrySchema — tag=text", () => {
  test("accepts a text-tagged entry with protocol + needsKey", () => {
    const r = catalogEntrySchema.safeParse({
      id: "openai",
      tag: "text",
      adapterKind: "openai",
      protocol: "openai-compat",
      needsKey: true,
      displayName: "OpenAI",
      description: "OpenAI chat models",
      defaultBaseUrl: "https://api.openai.com/v1",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.tag).toBe("text");
      expect(r.data.protocol).toBe("openai-compat");
      expect(r.data.needsKey).toBe(true);
    }
  });

  test("still accepts legacy image/video entries (backward compatible)", () => {
    const r = catalogEntrySchema.safeParse({
      id: "openai-images",
      tag: "image",
      adapterKind: "openai",
      displayName: "OpenAI Images",
      description: "x",
      defaultBaseUrl: "https://api.openai.com/v1",
    });
    expect(r.success).toBe(true);
  });

  test("rejects an unknown tag", () => {
    const r = catalogEntrySchema.safeParse({
      id: "x",
      tag: "embedding",
      adapterKind: "openai",
      displayName: "x",
      description: "x",
      defaultBaseUrl: "https://x/v1",
    });
    expect(r.success).toBe(false);
  });
});

describe("ModelPreset.params — per-entry-per-model param schema", () => {
  test("a preset carries its own params + token/vision metadata", () => {
    const r = catalogEntrySchema.safeParse({
      id: "openai",
      tag: "text",
      adapterKind: "openai",
      displayName: "OpenAI",
      description: "x",
      defaultBaseUrl: "https://api.openai.com/v1",
      modelPresets: [
        {
          value: "gpt-5.5",
          label: "GPT-5.5",
          maxContextTokens: 400000,
          maxOutputTokens: 128000,
          supportsVision: true,
          params: [
            {
              name: "reasoning",
              control: "enum",
              options: ["low", "medium", "high", "xhigh"],
              default: "medium",
              wire: { field: "reasoning_effort" },
            },
          ],
        },
        { value: "gpt-4o" }, // no params -> no adjustable knobs
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      const presets = r.data.modelPresets!;
      expect(presets[0]!.params![0]!.control).toBe("enum");
      expect(presets[0]!.supportsVision).toBe(true);
      expect(presets[1]!.params).toBeUndefined();
    }
  });
});

describe("paramSpecSchema — one generic shape, no special-casing", () => {
  test("enum control (e.g. reasoning effort / image size)", () => {
    const r = paramSpecSchema.safeParse({
      name: "size",
      control: "enum",
      options: ["1024x1024", "1536x1024"],
      default: "1024x1024",
      doc: "Output image dimensions.",
    });
    expect(r.success).toBe(true);
  });

  test("number control (e.g. anthropic thinking budget)", () => {
    const r = paramSpecSchema.safeParse({
      name: "reasoning",
      control: "number",
      min: 1024,
      default: 4096,
      wire: { field: "thinking.budget_tokens" },
    });
    expect(r.success).toBe(true);
  });

  test("toggle control (e.g. deepseek thinking)", () => {
    const r = paramSpecSchema.safeParse({ name: "thinking", control: "toggle", default: true });
    expect(r.success).toBe(true);
  });

  test("text control", () => {
    const r = paramSpecSchema.safeParse({ name: "system", control: "text" });
    expect(r.success).toBe(true);
  });

  test("rejects an unknown control type", () => {
    const r = paramSpecSchema.safeParse({ name: "x", control: "slider" });
    expect(r.success).toBe(false);
  });
});

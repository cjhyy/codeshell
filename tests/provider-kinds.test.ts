import { describe, it, expect } from "bun:test";
import { PROVIDER_KINDS, getKindMeta } from "../src/llm/provider-kinds.js";

describe("PROVIDER_KINDS", () => {
  it("includes all expected kinds", () => {
    const keys = Object.keys(PROVIDER_KINDS).sort();
    expect(keys).toEqual([
      "anthropic",
      "custom",
      "deepseek",
      "google",
      "groq",
      "mistral",
      "ollama",
      "openai",
      "openrouter",
      "xai",
      "zai",
    ]);
  });

  it("openai-compat kinds use Bearer auth", () => {
    for (const kind of ["deepseek", "openai", "xai", "mistral", "groq"] as const) {
      const meta = PROVIDER_KINDS[kind];
      const h = meta.authHeader("KEY");
      expect(h.Authorization).toBe("Bearer KEY");
    }
  });

  it("anthropic uses x-api-key + anthropic-version", () => {
    const h = PROVIDER_KINDS.anthropic.authHeader("KEY");
    expect(h["x-api-key"]).toBe("KEY");
    expect(h["anthropic-version"]).toBeTruthy();
  });

  it("chatFilter rejects embed/whisper/tts/image models", () => {
    const f = PROVIDER_KINDS.openai.chatFilter;
    expect(f("gpt-4o")).toBe(true);
    expect(f("text-embedding-3-small")).toBe(false);
    expect(f("whisper-1")).toBe(false);
    expect(f("tts-1")).toBe(false);
    expect(f("dall-e-3")).toBe(false);
  });

  it("getKindMeta returns custom for unknown values", () => {
    expect(getKindMeta("nonsense" as never).label).toBe("Custom");
  });

  it("ollama needs no api key (empty authHeader)", () => {
    const h = PROVIDER_KINDS.ollama.authHeader("anything");
    expect(Object.keys(h)).toHaveLength(0);
  });
});

import { describe, it, expect } from "bun:test";
import {
  KNOWN_MAX_OUTPUT,
  KNOWN_CONTEXT_WINDOWS,
  OPENROUTER_VENDORS,
  VERTEX_REGION_OVERRIDES,
  MODEL_PRICING,
  DEFAULT_PRICING,
  PROVIDERS,
} from "./model-metadata.js";
import { resolveMaxOutput, resolveContextWindow } from "../onboarding.js";
import { getVertexRegionForModel } from "../utils/envUtils.js";

/**
 * Phase-1 extraction guard: the model-metadata tables moved out of
 * onboarding.ts into data/model-metadata.json. These pin the values so a
 * typo in the JSON (or an accidental drop during a future edit) is caught,
 * and confirm onboarding's resolvers still read them.
 */
describe("model-metadata data layer", () => {
  it("loads the known-max-output table (direct-provider ids)", () => {
    // Representative entries spanning vendors + both id forms.
    expect(KNOWN_MAX_OUTPUT["claude-opus-4-7"]).toBe(32000);
    expect(KNOWN_MAX_OUTPUT["anthropic/claude-opus-4-7"]).toBe(32000);
    expect(KNOWN_MAX_OUTPUT["gpt-5-nano"]).toBe(16000);
    expect(KNOWN_MAX_OUTPUT["o3"]).toBe(100000);
    expect(KNOWN_MAX_OUTPUT["deepseek-v4-pro"]).toBe(65536);
  });

  it("loads the known-context-window table", () => {
    expect(KNOWN_CONTEXT_WINDOWS["deepseek-v4-pro"]).toBe(1_000_000);
    expect(KNOWN_CONTEXT_WINDOWS["deepseek/deepseek-chat"]).toBe(1_000_000);
  });

  it("loads the curated OpenRouter vendor order", () => {
    expect(OPENROUTER_VENDORS.map((v) => v.prefix)).toEqual([
      "anthropic/",
      "openai/",
      "google/",
      "deepseek/",
      "x-ai/",
      "qwen/",
      "meta-llama/",
      "mistralai/",
    ]);
    expect(OPENROUTER_VENDORS[0]).toEqual({ prefix: "anthropic/", take: 4 });
  });

  it("loads the Vertex region override table (prefix → env-var name)", () => {
    const map = new Map(VERTEX_REGION_OVERRIDES.map(([p, v]) => [p, v]));
    expect(map.get("claude-haiku-4-5")).toBe("VERTEX_REGION_CLAUDE_HAIKU_4_5");
    expect(map.get("claude-opus-4-1")).toBe("VERTEX_REGION_CLAUDE_4_1_OPUS");
    expect(map.get("claude-sonnet-4-6")).toBe("VERTEX_REGION_CLAUDE_4_6_SONNET");
    // Order matters: the more specific sonnet-4-6 / -4-5 must precede the bare
    // sonnet-4 so first-prefix-match wins correctly.
    const prefixes = VERTEX_REGION_OVERRIDES.map(([p]) => p);
    expect(prefixes.indexOf("claude-sonnet-4-6")).toBeLessThan(prefixes.indexOf("claude-sonnet-4"));
  });

  it("getVertexRegionForModel reads the extracted table via its env var", () => {
    const env = "VERTEX_REGION_CLAUDE_HAIKU_4_5";
    const prev = process.env[env];
    try {
      process.env[env] = "europe-west4";
      expect(getVertexRegionForModel("claude-haiku-4-5-20251001")).toBe("europe-west4");
    } finally {
      if (prev === undefined) delete process.env[env];
      else process.env[env] = prev;
    }
  });

  it("onboarding resolvers read the extracted tables (direct-provider lookup)", () => {
    // resolveMaxOutput/resolveContextWindow hit the KNOWN_* tables first for
    // ids without a vendor snapshot entry; these are direct-provider ids.
    expect(resolveMaxOutput("claude-opus-4-7")).toBe(32000);
    expect(resolveMaxOutput("o4-mini")).toBe(100000);
    expect(resolveContextWindow("deepseek-v4-pro")).toBe(1_000_000);
    // An id known to neither table nor a plausible snapshot id → undefined
    // (so callers can use `?? default`).
    expect(resolveMaxOutput("totally-unknown-model-xyz")).toBeUndefined();
  });

  it("MODEL_PRICING values + derived cache prices match the pre-extraction table", () => {
    // Anthropic: the pre-extraction entries had EXPLICIT cacheRead/cacheWrite;
    // the derived heuristic reproduces them (input/output exact, cache close-to
    // to absorb float representation — the prior explicit values WERE the
    // heuristic result, e.g. opus 15→1.5/18.75, sonnet 3→0.3/3.75).
    const opus = MODEL_PRICING["claude-opus-4-6"]!;
    expect([opus.input, opus.output]).toEqual([15, 75]);
    expect(opus.cacheRead).toBeCloseTo(1.5, 10);
    expect(opus.cacheWrite).toBeCloseTo(18.75, 10);
    const sonnet = MODEL_PRICING["claude-sonnet-4-6"]!;
    expect([sonnet.input, sonnet.output]).toEqual([3, 15]);
    expect(sonnet.cacheRead).toBeCloseTo(0.3, 10);
    expect(sonnet.cacheWrite).toBeCloseTo(3.75, 10);
    const haiku = MODEL_PRICING["claude-3.5-haiku"]!;
    expect([haiku.input, haiku.output]).toEqual([0.8, 4]);
    expect(haiku.cacheRead).toBeCloseTo(0.08, 10);
    expect(haiku.cacheWrite).toBeCloseTo(1, 10);
    // pricing()-derived entries (OpenAI/DeepSeek/etc.). input/output are exact;
    // cacheRead/cacheWrite are float-derived (input*0.1 / input*1.25) — same as
    // the old pricing() helper, so use close-to (the old code produced these
    // exact floats too, e.g. 3*0.1 === 0.30000000000000004).
    expect(MODEL_PRICING["gpt-5"]!.input).toBe(5);
    expect(MODEL_PRICING["gpt-5"]!.output).toBe(20);
    expect(MODEL_PRICING["gpt-5"]!.cacheRead).toBeCloseTo(0.5, 10);
    expect(MODEL_PRICING["gpt-5"]!.cacheWrite).toBeCloseTo(6.25, 10);
    expect(MODEL_PRICING["o4-mini"]!.input).toBe(1.1);
    expect(MODEL_PRICING["deepseek-v4-flash"]!.input).toBe(0.126);
    expect(MODEL_PRICING["deepseek-v4-flash"]!.output).toBe(0.252);
    expect(MODEL_PRICING["deepseek-v4-flash"]!.cacheRead).toBeCloseTo(0.0126, 10);
  });

  it("DEFAULT_PRICING is the [3,15] fallback with derived cache prices", () => {
    expect(DEFAULT_PRICING.input).toBe(3);
    expect(DEFAULT_PRICING.output).toBe(15);
    expect(DEFAULT_PRICING.cacheRead).toBeCloseTo(0.3, 10);
    expect(DEFAULT_PRICING.cacheWrite).toBeCloseTo(3.75, 10);
  });

  it("derived cache prices follow the read=10% / write=125% heuristic for every entry", () => {
    for (const [id, p] of Object.entries(MODEL_PRICING)) {
      expect(p.cacheRead).toBeCloseTo(p.input * 0.1, 10);
      expect(p.cacheWrite).toBeCloseTo(p.input * 1.25, 10);
      expect(id).toBeTruthy();
    }
  });

  it("loads the onboarding provider catalog with the zero-config default first", () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual([
      "openrouter",
      "anthropic",
      "openai",
      "deepseek",
      "zai",
      "gemini",
      "ollama",
      "custom",
    ]);
    // openrouter is the zero-config default; models[0] is the default pick.
    const or = PROVIDERS[0]!;
    expect(or.id).toBe("openrouter");
    expect(or.provider).toBe("openai");
    expect(or.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(or.keyPrefix).toBe("sk-or-");
    expect(or.models[0]).toBe("anthropic/claude-sonnet-4.6");
    // Anthropic uses the native adapter kind.
    expect(PROVIDERS.find((p) => p.id === "anthropic")!.provider).toBe("anthropic");
    // Local providers (ollama) skip the key prompt; custom has empty models.
    expect(PROVIDERS.find((p) => p.id === "ollama")!.noKey).toBe(true);
    expect(PROVIDERS.find((p) => p.id === "custom")!.models).toEqual([]);
  });
});

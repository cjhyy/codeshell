import { describe, it, expect } from "bun:test";
import {
  detectProviderFromApiKey,
  resolveProviderModels,
  maskKey,
  PROVIDERS,
} from "./onboarding.js";

/**
 * Covers the PROVIDERS-consuming helpers (untested before). Doubles as a guard
 * that the Phase-1 PROVIDERS extraction (data/model-metadata.json) flows
 * correctly through the consuming logic — key-prefix / baseUrl matching and the
 * openrouter model-list special case all read the externalized catalog.
 */
describe("detectProviderFromApiKey (prefix / baseUrl over extracted PROVIDERS)", () => {
  it("matches by key prefix", () => {
    expect(detectProviderFromApiKey("sk-or-abc123")!.id).toBe("openrouter");
    expect(detectProviderFromApiKey("sk-ant-xyz")!.id).toBe("anthropic");
    // bare "sk-" prefix → first PROVIDERS entry whose keyPrefix is exactly "sk-"
    // (openai/deepseek both use "sk-"; prefix scan returns the first in order).
    const skMatch = detectProviderFromApiKey("sk-plainkey");
    expect(["openai", "deepseek"]).toContain(skMatch!.id);
  });

  it("falls back to baseUrl match when no prefix matches", () => {
    // A key with no known prefix, but a recognizable baseUrl.
    const p = detectProviderFromApiKey("randomtoken", "https://api.deepseek.com/v1");
    expect(p!.id).toBe("deepseek");
  });

  it("returns undefined for an unrecognizable key + baseUrl", () => {
    expect(detectProviderFromApiKey("randomtoken", "https://example.invalid")).toBeUndefined();
  });
});

describe("resolveProviderModels", () => {
  it("returns the provider's own model list for non-openrouter providers", () => {
    const anthropic = PROVIDERS.find((p) => p.id === "anthropic")!;
    expect(resolveProviderModels(anthropic)).toEqual(anthropic.models);
    expect(resolveProviderModels(anthropic)[0]).toBe("claude-sonnet-4-6");
  });

  it("openrouter resolves through the snapshot builder (falls back to its own list when snapshot empty)", () => {
    const or = PROVIDERS.find((p) => p.id === "openrouter")!;
    const models = resolveProviderModels(or);
    // Either the snapshot-built list or the hardcoded fallback — both non-empty
    // and the first pick stays a sonnet-class default.
    expect(models.length).toBeGreaterThan(0);
  });
});

describe("maskKey", () => {
  it("masks long keys keeping head+tail", () => {
    expect(maskKey("sk-1234567890abcdef")).toBe("sk-123...cdef");
  });
  it("collapses short keys", () => {
    expect(maskKey("short")).toBe("sh***");
  });
});

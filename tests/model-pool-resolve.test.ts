import { describe, it, expect } from "bun:test";
import { ModelPool } from "../src/llm/model-pool.js";
import { ProviderCatalog } from "../src/llm/provider-catalog.js";

describe("ModelPool credential resolution", () => {
  it("pulls baseUrl/apiKey from providerCatalog via providerKey", () => {
    const cat = new ProviderCatalog([
      { key: "deepseek", kind: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKey: "kk" },
    ]);
    const pool = new ModelPool([
      { key: "ds-flash", provider: "", model: "deepseek-v4-flash", providerKey: "deepseek" } as never,
    ]);
    pool.setProviderCatalog(cat);
    const cfg = pool.resolveLLMConfig("ds-flash");
    expect(cfg?.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(cfg?.apiKey).toBe("kk");
  });

  it("falls back to entry-level apiKey when providerKey unset", () => {
    const pool = new ModelPool([
      { key: "legacy", provider: "openai", model: "gpt-4o", apiKey: "old", baseUrl: "https://x" },
    ]);
    const cfg = pool.resolveLLMConfig("legacy");
    expect(cfg?.apiKey).toBe("old");
    expect(cfg?.baseUrl).toBe("https://x");
  });

  it("entry-level apiKey overrides catalog when both present", () => {
    const cat = new ProviderCatalog([
      { key: "openai", kind: "openai", baseUrl: "https://x", apiKey: "fromCat" },
    ]);
    const pool = new ModelPool([
      { key: "m", provider: "openai", model: "gpt-4o", apiKey: "fromEntry", providerKey: "openai" } as never,
    ]);
    pool.setProviderCatalog(cat);
    const cfg = pool.resolveLLMConfig("m");
    expect(cfg?.apiKey).toBe("fromEntry");
  });

  it("maps non-anthropic kinds to openai client provider", () => {
    // client-factory only registers "anthropic" and "openai"; every other
    // kind (deepseek/openrouter/xai/mistral/groq/google/ollama/custom) is
    // OpenAI-compatible at the HTTP level and must resolve to "openai".
    for (const kind of ["deepseek", "openrouter", "xai", "mistral", "groq", "google", "ollama", "custom"] as const) {
      const cat = new ProviderCatalog([
        { key: kind, kind, baseUrl: "https://x", apiKey: "k" },
      ]);
      const pool = new ModelPool([
        { key: "m", provider: "", model: "x", providerKey: kind } as never,
      ]);
      pool.setProviderCatalog(cat);
      const cfg = pool.resolveLLMConfig("m");
      expect(cfg?.provider).toBe("openai");
    }
  });

  it("maps anthropic kind to anthropic client provider", () => {
    const cat = new ProviderCatalog([
      { key: "anthropic", kind: "anthropic", baseUrl: "https://x", apiKey: "k" },
    ]);
    const pool = new ModelPool([
      { key: "m", provider: "", model: "claude-opus-4-6", providerKey: "anthropic" } as never,
    ]);
    pool.setProviderCatalog(cat);
    const cfg = pool.resolveLLMConfig("m");
    expect(cfg?.provider).toBe("anthropic");
  });
});

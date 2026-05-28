import { describe, it, expect } from "bun:test";
import { ModelPool } from "../packages/core/src/llm/model-pool.js";
import { ProviderCatalog } from "../packages/core/src/llm/provider-catalog.js";

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

  // Regression: agent-server-stdio's engineFactory calls
  // runtime.modelPool.resolveLLMConfig() (no args) for every new session so
  // hot-switched models flow into newly-spawned sessions. The contract:
  // after pool.switch(key), resolveLLMConfig() with no args must return the
  // newly-active model — not the bootstrap default. See TODO-week.md #8.
  it("resolveLLMConfig() with no args follows pool.switch()", () => {
    const pool = new ModelPool([
      { key: "boot", provider: "openai", model: "gpt-5.5", apiKey: "k1", baseUrl: "https://a" },
      { key: "next", provider: "openai", model: "deepseek-v4-flash", apiKey: "k2", baseUrl: "https://b" },
    ]);
    // Bootstrap snapshot — what agent-server-stdio froze at startup.
    const boot = pool.resolveLLMConfig();
    expect(boot?.model).toBe("gpt-5.5");

    // Hot-switch via the same path Engine.switchModel() uses.
    pool.switch("next");

    // engineFactory(slice) for a new session now resolves against the pool.
    const live = pool.resolveLLMConfig();
    expect(live?.model).toBe("deepseek-v4-flash");
    expect(live?.apiKey).toBe("k2");
    expect(live?.baseUrl).toBe("https://b");
  });
});

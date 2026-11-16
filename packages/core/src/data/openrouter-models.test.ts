import { describe, it, expect } from "bun:test";
import {
  coerceSnapshot,
  getOpenRouterModels,
  getOpenRouterSnapshot,
  openRouterPriceFields,
  openRouterRequestPrice,
  setOpenRouterSnapshot,
} from "./openrouter-models.js";

// H2: the bundled snapshot is require'd at import. A missing/corrupt file must
// degrade to an EMPTY snapshot instead of crashing the whole module (which
// everything transitively importing model metadata would inherit). coerceSnapshot
// is the pure gate that decides valid-vs-empty; loadBundled wraps it in try/catch.
describe("coerceSnapshot (missing/corrupt-file degradation)", () => {
  it("passes a well-formed snapshot through", () => {
    const snap = { fetchedAt: "t", source: "s", count: 1, models: [{ id: "x" } as never] };
    expect(coerceSnapshot(snap)).toBe(snap);
  });

  it("degrades malformed values to an empty snapshot (never throws)", () => {
    for (const bad of [undefined, null, 42, "str", {}, { models: "nope" }, { models: null }]) {
      const out = coerceSnapshot(bad);
      expect(Array.isArray(out.models)).toBe(true);
      expect(out.models).toEqual([]);
      expect(out.count).toBe(0);
    }
  });
});

describe("openrouter-models accessors", () => {
  it("getOpenRouterModels always returns an array", () => {
    expect(Array.isArray(getOpenRouterModels())).toBe(true);
  });

  it("setOpenRouterSnapshot overrides the runtime snapshot", () => {
    const before = getOpenRouterSnapshot();
    setOpenRouterSnapshot({
      fetchedAt: "x",
      source: "test",
      count: 1,
      models: [
        {
          id: "vendor/m",
          name: "M",
          created: 0,
          contextLength: 1000,
          maxOutputTokens: 100,
          inputPricePerMillion: 1,
          outputPricePerMillion: 2,
          modalities: ["text"],
        },
      ],
    });
    expect(getOpenRouterModels().some((m) => m.id === "vendor/m")).toBe(true);
    // restore so we don't leak override into other tests in the same process
    setOpenRouterSnapshot(before);
  });
});

describe("OpenRouter published prices", () => {
  const raw = {
    prompt: "0.000002",
    completion: "0.00001",
    input_cache_read: "0.0000001",
    input_cache_write: "0.0000025",
    overrides: [
      {
        min_prompt_tokens: 272000,
        prompt: "0.000004",
        completion: "0.000015",
        input_cache_read: "0.0000002",
        input_cache_write: "0.000005",
      },
    ],
  };
  const model = {
    id: "openai/test",
    name: "Test",
    created: 0,
    contextLength: 1_000_000,
    maxOutputTokens: 1000,
    modalities: ["text"],
    ...openRouterPriceFields(raw),
  };

  it("parses cache prices and size tiers without float noise", () => {
    expect(openRouterPriceFields(raw)).toEqual({
      inputPricePerMillion: 2,
      outputPricePerMillion: 10,
      cacheReadPricePerMillion: 0.1,
      cacheWritePricePerMillion: 2.5,
      priceTiers: [
        {
          minPromptTokens: 272000,
          inputPricePerMillion: 4,
          outputPricePerMillion: 15,
          cacheReadPricePerMillion: 0.2,
          cacheWritePricePerMillion: 5,
        },
      ],
    });
  });

  it("prices the whole request at the tier its prompt reaches", () => {
    expect(openRouterRequestPrice(model, 271_999)).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
      cachePricesEstimated: false,
    });
    expect(openRouterRequestPrice(model, 272_000)).toEqual({
      input: 4,
      output: 15,
      cacheRead: 0.2,
      cacheWrite: 5,
      cachePricesEstimated: false,
    });
  });

  it("falls back to the estimate only when cache prices are not published", () => {
    const legacy = { ...model, priceTiers: undefined, cacheReadPricePerMillion: undefined };
    expect(openRouterRequestPrice(legacy)).toMatchObject({
      cacheRead: 0.2,
      cacheWrite: 2.5,
      cachePricesEstimated: true,
    });
    expect(openRouterPriceFields({ prompt: "0.000001", overrides: [{ prompt: "x" }] })).toEqual({
      inputPricePerMillion: 1,
      outputPricePerMillion: 0,
    });
  });

  it("ships published cache prices for the default GPT route", () => {
    const sol = getOpenRouterModels().find((entry) => entry.id === "openai/gpt-6.1-sol");
    expect(sol?.cacheReadPricePerMillion).toBeGreaterThan(0);
    expect(sol?.cacheWritePricePerMillion).toBeGreaterThan(0);
  });
});

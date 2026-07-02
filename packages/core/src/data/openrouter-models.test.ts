import { describe, it, expect } from "bun:test";
import {
  coerceSnapshot,
  getOpenRouterModels,
  getOpenRouterSnapshot,
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
    setOpenRouterSnapshot({ fetchedAt: "x", source: "test", count: 1, models: [
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
    ] });
    expect(getOpenRouterModels().some((m) => m.id === "vendor/m")).toBe(true);
    // restore so we don't leak override into other tests in the same process
    setOpenRouterSnapshot(before);
  });
});

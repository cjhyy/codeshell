/**
 * resolveInstance — turn a stored ModelInstance + catalog into the runtime
 * shape any capability entry (chat / GenerateImage / GenerateVideo) consumes.
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §6.
 */
import { describe, test, expect } from "bun:test";
import { resolveInstance } from "./resolve.js";
import type { CatalogEntry } from "./types.js";
import type { ModelInstance } from "./resolve.js";

const CATALOG: CatalogEntry[] = [
  {
    id: "openai",
    tag: "text",
    adapterKind: "openai",
    protocol: "openai-compat",
    displayName: "OpenAI",
    description: "x",
    defaultBaseUrl: "https://api.openai.com/v1",
    modelPresets: [
      {
        value: "gpt-5.5",
        params: [{ name: "reasoning", control: "enum", options: ["low", "high"], wire: { field: "reasoning_effort" } }],
      },
      { value: "gpt-4o" },
    ],
  },
];

describe("resolveInstance", () => {
  test("resolves entry/adapterKind/preset/paramValues for a direct-key instance", () => {
    const inst: ModelInstance = {
      id: "a",
      catalogId: "openai",
      tag: "text",
      model: "gpt-5.5",
      apiKey: "sk-direct",
      paramValues: { reasoning: "high" },
    };
    const r = resolveInstance(inst, [inst], CATALOG);
    expect(r).not.toBeNull();
    expect(r!.entry.id).toBe("openai");
    expect(r!.adapterKind).toBe("openai");
    expect(r!.apiKey).toBe("sk-direct");
    expect(r!.preset?.value).toBe("gpt-5.5");
    expect(r!.paramValues).toEqual({ reasoning: "high" });
    expect(r!.baseUrl).toBe("https://api.openai.com/v1"); // falls back to entry default
  });

  test("apiKeyRef borrows another instance's key", () => {
    const owner: ModelInstance = { id: "owner", catalogId: "openai", tag: "text", model: "gpt-5.5", apiKey: "sk-shared" };
    const borrower: ModelInstance = { id: "b", catalogId: "openai", tag: "text", model: "gpt-4o", apiKeyRef: "owner" };
    const r = resolveInstance(borrower, [owner, borrower], CATALOG);
    expect(r!.apiKey).toBe("sk-shared");
  });

  test("direct apiKey wins over apiKeyRef", () => {
    const owner: ModelInstance = { id: "owner", catalogId: "openai", tag: "text", model: "gpt-5.5", apiKey: "sk-shared" };
    const inst: ModelInstance = { id: "b", catalogId: "openai", tag: "text", model: "gpt-4o", apiKey: "sk-own", apiKeyRef: "owner" };
    const r = resolveInstance(inst, [owner, inst], CATALOG);
    expect(r!.apiKey).toBe("sk-own");
  });

  test("instance baseUrl overrides the entry default", () => {
    const inst: ModelInstance = { id: "a", catalogId: "openai", tag: "text", model: "gpt-5.5", apiKey: "k", baseUrl: "https://proxy/v1" };
    const r = resolveInstance(inst, [inst], CATALOG);
    expect(r!.baseUrl).toBe("https://proxy/v1");
  });

  test("unknown catalogId returns null", () => {
    const inst: ModelInstance = { id: "a", catalogId: "nope", tag: "text", model: "m", apiKey: "k" };
    expect(resolveInstance(inst, [inst], CATALOG)).toBeNull();
  });

  test("apiKeyRef pointing at a missing instance yields no key (not a crash)", () => {
    const inst: ModelInstance = { id: "a", catalogId: "openai", tag: "text", model: "gpt-4o", apiKeyRef: "ghost" };
    const r = resolveInstance(inst, [inst], CATALOG);
    expect(r!.apiKey).toBeUndefined();
  });

  test("preset is undefined when the model isn't in modelPresets (still resolves)", () => {
    const inst: ModelInstance = { id: "a", catalogId: "openai", tag: "text", model: "gpt-9-unknown", apiKey: "k" };
    const r = resolveInstance(inst, [inst], CATALOG);
    expect(r!.preset).toBeUndefined();
    expect(r!.entry.id).toBe("openai");
  });
});

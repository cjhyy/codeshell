/**
 * L6b engine consumption — the engine loads settings.modelConnections[] into
 * the model pool, so the unified instance store actually drives which model
 * sends requests. modelEntriesFromConnections is the pure bridge: instances +
 * catalog → ModelEntry[] (apiKeyRef dereferenced, protocol resolved, params
 * applied to the entry's reasoning fields where relevant).
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §6.
 */
import { describe, test, expect } from "bun:test";
import { modelEntriesFromConnections } from "./model-connections-pool.js";
import type { CatalogEntry } from "../model-catalog/index.js";
import type { ModelInstance } from "../model-catalog/resolve.js";

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
      { value: "gpt-5.5", maxContextTokens: 400000, maxOutputTokens: 128000 },
      { value: "gpt-4o" },
    ],
  },
  {
    id: "anthropic",
    tag: "text",
    adapterKind: "anthropic",
    protocol: "anthropic-style",
    displayName: "Anthropic",
    description: "x",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    modelPresets: [{ value: "claude-opus-4-7" }],
  },
];

describe("modelEntriesFromConnections", () => {
  test("maps a text instance to a ModelEntry keyed by instance id", () => {
    const insts: ModelInstance[] = [
      { id: "my-gpt5", catalogId: "openai", tag: "text", model: "gpt-5.5", apiKey: "sk-1" },
    ];
    const entries = modelEntriesFromConnections(insts, CATALOG);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.key).toBe("my-gpt5");
    expect(e.model).toBe("gpt-5.5");
    expect(e.apiKey).toBe("sk-1");
    expect(e.baseUrl).toBe("https://api.openai.com/v1");
  });

  test("only text instances become model-pool entries (image/video excluded)", () => {
    const insts: ModelInstance[] = [
      { id: "t", catalogId: "openai", tag: "text", model: "gpt-4o", apiKey: "k" },
      { id: "img", catalogId: "openai-images", tag: "image", model: "gpt-image-2", apiKey: "k" },
    ];
    const entries = modelEntriesFromConnections(insts, CATALOG);
    expect(entries.map((e) => e.key)).toEqual(["t"]);
  });

  test("protocol comes from the catalog entry (openai vs anthropic)", () => {
    const insts: ModelInstance[] = [
      { id: "o", catalogId: "openai", tag: "text", model: "gpt-4o", apiKey: "k" },
      { id: "a", catalogId: "anthropic", tag: "text", model: "claude-opus-4-7", apiKey: "k" },
    ];
    const entries = modelEntriesFromConnections(insts, CATALOG);
    expect(entries.find((e) => e.key === "o")!.provider).toBe("openai");
    expect(entries.find((e) => e.key === "a")!.provider).toBe("anthropic");
  });

  test("apiKeyRef borrows the referenced instance's key", () => {
    const insts: ModelInstance[] = [
      { id: "owner", catalogId: "openai", tag: "text", model: "gpt-5.5", apiKey: "sk-shared" },
      { id: "borrow", catalogId: "openai", tag: "text", model: "gpt-4o", apiKeyRef: "owner" },
    ];
    const entries = modelEntriesFromConnections(insts, CATALOG);
    expect(entries.find((e) => e.key === "borrow")!.apiKey).toBe("sk-shared");
  });

  test("carries token limits from the matched preset", () => {
    const insts: ModelInstance[] = [
      { id: "g", catalogId: "openai", tag: "text", model: "gpt-5.5", apiKey: "k" },
    ];
    const e = modelEntriesFromConnections(insts, CATALOG)[0]!;
    expect(e.maxContextTokens).toBe(400000);
    expect(e.maxOutputTokens).toBe(128000);
  });

  test("paramValues.reasoning enum → ModelEntry.reasoning effort", () => {
    const insts: ModelInstance[] = [
      { id: "g", catalogId: "openai", tag: "text", model: "gpt-5.5", apiKey: "k", paramValues: { reasoning: "high" } },
    ];
    const e = modelEntriesFromConnections(insts, CATALOG)[0]!;
    expect(e.reasoning).toEqual({ mode: "effort", effort: "high" });
  });

  test("paramValues.reasoning number → ModelEntry.reasoning budget", () => {
    const insts: ModelInstance[] = [
      { id: "c", catalogId: "anthropic", tag: "text", model: "claude-opus-4-7", apiKey: "k", paramValues: { reasoning: 8192 } },
    ];
    const e = modelEntriesFromConnections(insts, CATALOG)[0]!;
    expect(e.reasoning).toEqual({ mode: "budget", budgetTokens: 8192 });
  });

  test("paramValues.reasoning boolean → ModelEntry.reasoning on/off", () => {
    const on: ModelInstance[] = [
      { id: "d", catalogId: "openai", tag: "text", model: "gpt-4o", apiKey: "k", paramValues: { reasoning: true } },
    ];
    expect(modelEntriesFromConnections(on, CATALOG)[0]!.reasoning).toEqual({ mode: "on" });
    const off: ModelInstance[] = [
      { id: "d", catalogId: "openai", tag: "text", model: "gpt-4o", apiKey: "k", paramValues: { reasoning: false } },
    ];
    expect(modelEntriesFromConnections(off, CATALOG)[0]!.reasoning).toEqual({ mode: "off" });
  });

  test("no paramValues → no reasoning on the entry", () => {
    const insts: ModelInstance[] = [
      { id: "g", catalogId: "openai", tag: "text", model: "gpt-4o", apiKey: "k" },
    ];
    expect(modelEntriesFromConnections(insts, CATALOG)[0]!.reasoning).toBeUndefined();
  });

  test("instance with an unknown catalogId is skipped (not a crash)", () => {
    const insts: ModelInstance[] = [
      { id: "ok", catalogId: "openai", tag: "text", model: "gpt-4o", apiKey: "k" },
      { id: "bad", catalogId: "ghost", tag: "text", model: "m", apiKey: "k" },
    ];
    const entries = modelEntriesFromConnections(insts, CATALOG);
    expect(entries.map((e) => e.key)).toEqual(["ok"]);
  });
});

/**
 * Pure logic for the text connection panel (L6a display layer): build a
 * ModelInstance from a catalog template + picked model, generate a unique id,
 * and list key-reuse candidates. No window / no engine. Mirrors the design's
 * "选了什么 in the instance, 能选什么 in the catalog" split.
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §3.3/§5.
 */
import { describe, test, expect } from "bun:test";
import type { CatalogEntry } from "../../preload/types";
import {
  buildTextInstance,
  uniqueInstanceId,
  reuseKeyCandidates,
  reuseKeyLabel,
  type ModelInstance,
} from "./textConnections";

const OPENAI: CatalogEntry = {
  id: "openai",
  tag: "text",
  adapterKind: "openai",
  protocol: "openai-compat",
  displayName: "OpenAI",
  description: "x",
  defaultBaseUrl: "https://api.openai.com/v1",
  defaultModel: "gpt-5.5",
  needsKey: true,
  modelPresets: [
    {
      value: "gpt-5.5",
      params: [{ name: "reasoning", control: "enum", options: ["low", "high"], default: "low" }],
    },
  ],
};

describe("uniqueInstanceId", () => {
  test("uses the catalog id when free", () => {
    expect(uniqueInstanceId("openai", new Set())).toBe("openai");
  });
  test("suffixes on collision", () => {
    expect(uniqueInstanceId("openai", new Set(["openai"]))).toBe("openai-2");
    expect(uniqueInstanceId("openai", new Set(["openai", "openai-2"]))).toBe("openai-3");
  });
});

describe("buildTextInstance", () => {
  test("builds a tag=text instance pointing at the catalog entry", () => {
    const inst = buildTextInstance(OPENAI, "gpt-5.5", new Set());
    expect(inst.tag).toBe("text");
    expect(inst.catalogId).toBe("openai");
    expect(inst.model).toBe("gpt-5.5");
    expect(inst.baseUrl).toBe("https://api.openai.com/v1");
  });

  test("seeds paramValues from the preset's param defaults", () => {
    const inst = buildTextInstance(OPENAI, "gpt-5.5", new Set());
    expect(inst.paramValues).toEqual({ reasoning: "low" });
  });

  test("falls back to entry.defaultModel when no model given", () => {
    const inst = buildTextInstance(OPENAI, undefined, new Set());
    expect(inst.model).toBe("gpt-5.5");
  });
});

describe("reuseKeyCandidates", () => {
  const all: ModelInstance[] = [
    { id: "openai", catalogId: "openai", tag: "text", model: "gpt-5.5", apiKey: "sk-1" },
    { id: "openai-2", catalogId: "openai", tag: "text", model: "gpt-4o" }, // no key
    { id: "anth", catalogId: "anthropic", tag: "text", model: "claude", apiKey: "sk-2" },
  ];
  test("lists same-catalog instances that have a key, excluding self", () => {
    const cands = reuseKeyCandidates(all, { id: "openai-2", catalogId: "openai" });
    expect(cands.map((c) => c.id)).toEqual(["openai"]);
  });
  test("excludes other-catalog instances (a key belongs to one provider account)", () => {
    const cands = reuseKeyCandidates(all, { id: "openai-2", catalogId: "openai" });
    expect(cands.some((c) => c.id === "anth")).toBe(false);
  });
});

describe("reuseKeyLabel", () => {
  test("shows the connection name + last 4 of the key (not the model)", () => {
    const inst: ModelInstance = {
      id: "fal",
      catalogId: "fal-video",
      tag: "text",
      model: "fal-ai/kling-video/v3/pro/text-to-video",
      apiKey: "fal-secret-key-a1b2",
    };
    const label = reuseKeyLabel(inst, "fal.ai (Kling)");
    expect(label).toContain("fal.ai (Kling)");
    expect(label).toContain("#fal");
    expect(label).toContain("a1b2"); // last 4 of key
    expect(label).not.toContain("kling-video"); // model name is NOT in the label
  });

  test("omits the key suffix when the instance has no direct key", () => {
    const inst: ModelInstance = { id: "x", catalogId: "openai", tag: "text", model: "gpt-4o" };
    const label = reuseKeyLabel(inst, "OpenAI");
    expect(label).toContain("OpenAI");
    expect(label).toContain("#x");
    expect(label).not.toContain("····");
  });

  test("falls back to the id when no display name is given", () => {
    const inst: ModelInstance = { id: "x", catalogId: "openai", tag: "text", model: "m", apiKey: "key-wxyz" };
    expect(reuseKeyLabel(inst)).toContain("#x");
  });
});

/**
 * catalogModelOptions — the shared bridge every "pick a model" dropdown uses
 * (chat switcher, sub-agent model, aux). Maps text modelConnections → picker
 * options via the catalog; key = instance id (== engine pool key, so the
 * dropdown speaks the same ids the engine runs).
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §6.
 */
import { describe, test, expect } from "bun:test";
import { catalogModelOptions, type ModelInstance } from "./textConnections";
import type { CatalogEntry } from "../../preload/types";

const CATALOG: CatalogEntry[] = [
  {
    id: "openai",
    tag: "text",
    adapterKind: "openai",
    displayName: "OpenAI",
    description: "x",
    defaultBaseUrl: "https://api.openai.com/v1",
    modelPresets: [
      { value: "gpt-5.5", label: "GPT-5.5", maxContextTokens: 400000, supportsVision: true },
      { value: "gpt-4o" },
    ],
  },
  {
    id: "fal-video",
    tag: "video",
    adapterKind: "fal",
    displayName: "fal",
    description: "x",
    defaultBaseUrl: "https://queue.fal.run",
  },
];

describe("catalogModelOptions", () => {
  test("maps a text connection to a picker option keyed by instance id", () => {
    const conns: ModelInstance[] = [
      { id: "my-gpt5", catalogId: "openai", tag: "text", model: "gpt-5.5" },
    ];
    const opts = catalogModelOptions(conns, CATALOG);
    expect(opts).toEqual([
      { key: "my-gpt5", label: "GPT-5.5", provider: "OpenAI", maxContextTokens: 400000, supportsVision: true },
    ]);
  });

  test("label falls back to the model id when the preset has no label", () => {
    const conns: ModelInstance[] = [{ id: "o", catalogId: "openai", tag: "text", model: "gpt-4o" }];
    expect(catalogModelOptions(conns, CATALOG)[0]!.label).toBe("gpt-4o");
  });

  test("excludes non-text connections (image/video)", () => {
    const conns: ModelInstance[] = [
      { id: "t", catalogId: "openai", tag: "text", model: "gpt-4o" },
      { id: "v", catalogId: "fal-video", tag: "video", model: "kling" },
    ];
    expect(catalogModelOptions(conns, CATALOG).map((o) => o.key)).toEqual(["t"]);
  });

  test("drops connections whose catalogId doesn't resolve (stale store)", () => {
    const conns: ModelInstance[] = [
      { id: "ok", catalogId: "openai", tag: "text", model: "gpt-4o" },
      { id: "ghost", catalogId: "removed", tag: "text", model: "m" },
    ];
    expect(catalogModelOptions(conns, CATALOG).map((o) => o.key)).toEqual(["ok"]);
  });

  test("provider is the catalog displayName (not the raw catalogId)", () => {
    const conns: ModelInstance[] = [{ id: "x", catalogId: "openai", tag: "text", model: "gpt-5.5" }];
    expect(catalogModelOptions(conns, CATALOG)[0]!.provider).toBe("OpenAI");
  });
});

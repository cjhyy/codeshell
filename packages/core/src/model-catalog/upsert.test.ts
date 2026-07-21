/**
 * upsertCatalogEntry — pure add-or-update of a CatalogEntry into the user
 * catalog array, keyed by id. The catalog edit tool wraps this with
 * backup + validate + write. Pure so the replace semantics are unit-tested
 * without touching disk.
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §7.
 */
import { describe, test, expect } from "bun:test";
import { upsertCatalogEntry, upsertModelPreset } from "./upsert.js";
import type { CatalogEntry } from "./types.js";

const A: CatalogEntry = {
  id: "prov-a",
  tag: "text",
  adapterKind: "openai",
  displayName: "A",
  description: "x",
  defaultBaseUrl: "https://a/v1",
};
const B: CatalogEntry = {
  id: "prov-b",
  tag: "text",
  adapterKind: "openai",
  displayName: "B",
  description: "y",
  defaultBaseUrl: "https://b/v1",
};

describe("upsertCatalogEntry", () => {
  test("adds a new entry to an empty list", () => {
    const out = upsertCatalogEntry([], A);
    expect(out).toEqual([A]);
  });

  test("appends when the id is new", () => {
    const out = upsertCatalogEntry([A], B);
    expect(out.map((e) => e.id)).toEqual(["prov-a", "prov-b"]);
  });

  test("replaces the existing entry with the same id (update), in place", () => {
    const updated: CatalogEntry = { ...A, displayName: "A renamed", defaultModel: "m1" };
    const out = upsertCatalogEntry([A, B], updated);
    expect(out).toHaveLength(2);
    expect(out[0]!.displayName).toBe("A renamed");
    expect(out[0]!.defaultModel).toBe("m1");
    expect(out[1]).toEqual(B); // others untouched, order preserved
  });

  test("does not mutate the input array", () => {
    const input = [A];
    upsertCatalogEntry(input, B);
    expect(input).toEqual([A]);
  });
});

describe("upsertModelPreset", () => {
  test("appends a new model without changing existing presets", () => {
    const existing = [{ value: "model-a", label: "A" }];
    expect(upsertModelPreset(existing, { value: "model-b", label: "B" })).toEqual([
      { value: "model-a", label: "A" },
      { value: "model-b", label: "B" },
    ]);
    expect(existing).toEqual([{ value: "model-a", label: "A" }]);
  });

  test("updates an existing model by value without duplicating it", () => {
    expect(
      upsertModelPreset(
        [
          { value: "model-a", label: "Old" },
          { value: "model-b", label: "B" },
        ],
        { value: "model-a", label: "New" },
      ),
    ).toEqual([
      { value: "model-a", label: "New" },
      { value: "model-b", label: "B" },
    ]);
  });
});

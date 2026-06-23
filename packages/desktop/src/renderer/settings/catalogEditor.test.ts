/**
 * Pure logic helpers for the manual catalog entry editor:
 * blank template, origin → button kind, and required-field validation.
 */
import { describe, it, expect } from "bun:test";
import { blankCatalogEntry, deleteAction, validateEntry } from "./catalogEditor";

describe("catalogEditor", () => {
  it("blankCatalogEntry produces a minimal text entry", () => {
    const e = blankCatalogEntry("text");
    expect(e.tag).toBe("text");
    expect(e.id).toBe("");
    expect(e.adapterKind).toBe("openai");
    expect(e.modelPresets).toEqual([]);
    expect(e.needsKey).toBe(true);
  });
  it("deleteAction maps origin → button kind", () => {
    expect(deleteAction("user")).toBe("delete");
    expect(deleteAction("user-override-of-builtin")).toBe("reset");
    expect(deleteAction("builtin")).toBe("none");
  });
  it("validateEntry returns missing field-name tokens", () => {
    // blank entry has adapterKind "openai" already → only id/displayName/baseUrl missing
    expect(validateEntry(blankCatalogEntry("text"))).toEqual(["id", "displayName", "defaultBaseUrl"]);
    const ok = { ...blankCatalogEntry("text"), id: "x", displayName: "X", defaultBaseUrl: "https://u/v1" };
    expect(validateEntry(ok)).toEqual([]);
  });
});

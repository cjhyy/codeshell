import { expect, test } from "bun:test";
import { applyParams, buildParamsDoc } from "../../../packages/core/src/model-catalog/params.js";
import { upsertCatalogEntry, upsertModelPreset } from "../../../packages/core/src/model-catalog/upsert.js";
import { catalogEntrySchema, type CatalogEntry, type ParamSpec } from "../../../packages/core/src/model-catalog/types.js";

test("wire projection preserves false, zero, empty text and omits undefined", () => {
  const params: ParamSpec[] = [
    { name: "enabled", control: "toggle", wire: { field: "options.enabled" } },
    { name: "count", control: "number", wire: { field: "options.count" } },
    { name: "label", control: "text", wire: { field: "label" } },
    { name: "absent", control: "text" },
  ];
  const values = { enabled: false, count: 0, label: "", absent: undefined, unknown: "ignored" };
  expect(applyParams(values, params)).toEqual({ options: { enabled: false, count: 0 }, label: "" });
  expect(values).toEqual({ enabled: false, count: 0, label: "", absent: undefined, unknown: "ignored" });
});

test("distinct dotted fields share their enclosing object", () => {
  const params: ParamSpec[] = [
    { name: "width", control: "number", wire: { field: "output.dimensions.width" } },
    { name: "height", control: "number", wire: { field: "output.dimensions.height" } },
    { name: "format", control: "text", wire: { field: "output.format" } },
  ];
  expect(applyParams({ width: 640, height: 480, format: "png" }, params)).toEqual({
    output: { dimensions: { width: 640, height: 480 }, format: "png" },
  });
});

test("schema-parsed model id replacement preserves other entries and original arrays", () => {
  const original = catalogEntrySchema.parse({
    id: "audit-provider", tag: "text", adapterKind: "custom", protocol: "openai-compat",
    displayName: "Audit provider", description: "In-memory fixture", defaultBaseUrl: "https://invalid.test/v1",
    modelPresets: [{ value: "vendor/model:revision", label: "Old" }, { value: "vendor/other", label: "Other" }],
  });
  const existing: CatalogEntry[] = [original, { ...original, id: "other-provider" }];
  const replacement = { ...original, modelPresets: upsertModelPreset(original.modelPresets!, { value: "vendor/model:revision", label: "New" }) };
  const result = upsertCatalogEntry(existing, replacement);
  expect(result).toHaveLength(2);
  expect(result[0]!.modelPresets).toEqual([{ value: "vendor/model:revision", label: "New" }, { value: "vendor/other", label: "Other" }]);
  expect(result[1]).toBe(existing[1]);
  expect(original.modelPresets![0]!.label).toBe("Old");
  expect(existing[0]).toBe(original);
});

test("documentation formatter preserves model-specific enum labels and optional docs", () => {
  expect(buildParamsDoc([
    { name: "quality", control: "enum", options: ["draft", "final"], doc: "Own declared values." },
    { name: "caption", control: "text" },
  ])).toBe("quality (draft | final) — Own declared values.; caption");
  expect(buildParamsDoc(undefined)).toBe("");
});

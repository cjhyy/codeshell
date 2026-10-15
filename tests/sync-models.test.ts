import { describe, expect, it } from "bun:test";
import { CURATED_MODEL_IDS, selectCuratedModels } from "../scripts/sync-models.js";

describe("OpenRouter curated model sync", () => {
  it("selects only allowlisted models in curated order", () => {
    const raw = [
      { id: "other/model", name: "Other" },
      { id: CURATED_MODEL_IDS[1], name: "Second" },
      { id: CURATED_MODEL_IDS[0], name: "First" },
    ];

    const selected = selectCuratedModels(raw);

    expect(selected.models.map((model) => model.id)).toEqual([
      CURATED_MODEL_IDS[0],
      CURATED_MODEL_IDS[1],
    ]);
    expect(selected.missing).toEqual(CURATED_MODEL_IDS.slice(2));
  });

  it("contains the current GPT-6.1 Sol models without batch or free variants", () => {
    expect(CURATED_MODEL_IDS).toContain("openai/gpt-6.1-sol");
    expect(CURATED_MODEL_IDS).toContain("openai/gpt-6.1-sol-pro");
    expect(CURATED_MODEL_IDS).toHaveLength(20);
    expect(CURATED_MODEL_IDS.some((id) => id.endsWith(":batch") || id.endsWith(":free"))).toBe(
      false,
    );
  });
});

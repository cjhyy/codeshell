/**
 * Unified instance layer — settings.modelConnections[] + settings.defaults.
 * Replaces providers[]/models[]/imageGen/videoGen as the single instance store.
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §3.3.
 */
import { describe, it, expect } from "bun:test";
import { SettingsSchema } from "./schema.js";

describe("settings.modelConnections", () => {
  it("defaults to empty array", () => {
    const parsed = SettingsSchema.parse({});
    expect(parsed.modelConnections).toEqual([]);
  });

  it("accepts a full text instance with apiKeyRef + paramValues", () => {
    const parsed = SettingsSchema.parse({
      modelConnections: [
        {
          id: "my-gpt5",
          catalogId: "openai",
          tag: "text",
          model: "gpt-5.5",
          apiKey: "sk-abc",
          paramValues: { reasoning: "high" },
        },
        {
          id: "my-gpt5-mini",
          catalogId: "openai",
          tag: "text",
          model: "gpt-5-mini",
          apiKeyRef: "my-gpt5", // reuse the key from the instance above
        },
      ],
    });
    expect(parsed.modelConnections).toHaveLength(2);
    expect(parsed.modelConnections[0]!.paramValues).toEqual({ reasoning: "high" });
    expect(parsed.modelConnections[1]!.apiKeyRef).toBe("my-gpt5");
  });

  it("accepts image and video instances under the same schema", () => {
    const parsed = SettingsSchema.parse({
      modelConnections: [
        { id: "img1", catalogId: "openai-images", tag: "image", model: "gpt-image-2", apiKey: "k" },
        { id: "vid1", catalogId: "fal-video", tag: "video", model: "fal-ai/kling", apiKey: "k" },
      ],
    });
    expect(parsed.modelConnections.map((c) => c.tag)).toEqual(["image", "video"]);
  });

  it("rejects an unknown tag", () => {
    expect(() =>
      SettingsSchema.parse({
        modelConnections: [{ id: "x", catalogId: "y", tag: "embedding", model: "m" }],
      }),
    ).toThrow();
  });
});

describe("settings.defaults", () => {
  it("defaults to an empty object", () => {
    const parsed = SettingsSchema.parse({});
    expect(parsed.defaults).toEqual({});
  });

  it("holds per-tag default instance ids + auxText", () => {
    const parsed = SettingsSchema.parse({
      defaults: { text: "my-gpt5", image: "img1", video: "vid1", auxText: "my-gpt5-mini" },
    });
    expect(parsed.defaults.text).toBe("my-gpt5");
    expect(parsed.defaults.auxText).toBe("my-gpt5-mini");
  });
});

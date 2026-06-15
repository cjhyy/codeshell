/**
 * Unified instance layer — settings.credentials[] + modelConnections[] +
 * defaults. Credentials are an independent entity (key lives here); connections
 * reference one by credentialId — so deleting a connection never loses a key,
 * and many connections share one key by referencing the same credential
 * (LiteLLM credential_list model). Replaces providers[]/models[]/imageGen/
 * videoGen + the old per-connection apiKey/apiKeyRef.
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §3.3.
 */
import { describe, it, expect } from "bun:test";
import { SettingsSchema } from "./schema.js";

describe("settings.credentials", () => {
  it("defaults to empty array", () => {
    expect(SettingsSchema.parse({}).credentials).toEqual([]);
  });

  it("holds independent key entities keyed by catalogId", () => {
    const parsed = SettingsSchema.parse({
      credentials: [{ id: "openai-acct", catalogId: "openai", apiKey: "sk-abc", baseUrl: "https://x/v1" }],
    });
    expect(parsed.credentials[0]!.apiKey).toBe("sk-abc");
    expect(parsed.credentials[0]!.catalogId).toBe("openai");
  });
});

describe("settings.modelConnections", () => {
  it("defaults to empty array", () => {
    const parsed = SettingsSchema.parse({});
    expect(parsed.modelConnections).toEqual([]);
  });

  it("references a credential by id (key not inlined on the connection)", () => {
    const parsed = SettingsSchema.parse({
      credentials: [{ id: "openai-acct", catalogId: "openai", apiKey: "sk-abc" }],
      modelConnections: [
        {
          id: "my-gpt5",
          catalogId: "openai",
          tag: "text",
          model: "gpt-5.5",
          credentialId: "openai-acct",
          paramValues: { reasoning: "high" },
        },
        {
          id: "my-gpt5-mini",
          catalogId: "openai",
          tag: "text",
          model: "gpt-5-mini",
          credentialId: "openai-acct", // same credential → shared key
        },
      ],
    });
    expect(parsed.modelConnections).toHaveLength(2);
    expect(parsed.modelConnections[0]!.paramValues).toEqual({ reasoning: "high" });
    expect(parsed.modelConnections[0]!.credentialId).toBe("openai-acct");
    expect(parsed.modelConnections[1]!.credentialId).toBe("openai-acct");
  });

  it("accepts image and video connections under the same schema", () => {
    const parsed = SettingsSchema.parse({
      modelConnections: [
        { id: "img1", catalogId: "openai-images", tag: "image", model: "gpt-image-2", credentialId: "c" },
        { id: "vid1", catalogId: "fal-video", tag: "video", model: "fal-ai/kling", credentialId: "c" },
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

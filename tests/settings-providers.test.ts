import { describe, it, expect } from "bun:test";
import { validateSettings } from "../src/settings/schema.js";

describe("settings schema — providers", () => {
  it("accepts providers[] block", () => {
    const s = validateSettings({
      providers: [
        { key: "deepseek", kind: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKey: "k" },
      ],
    });
    expect(s.providers.length).toBe(1);
    expect(s.providers[0].kind).toBe("deepseek");
  });

  it("rejects unknown kind", () => {
    expect(() =>
      validateSettings({
        providers: [{ key: "x", kind: "nope", baseUrl: "https://x", apiKey: "k" }],
      }),
    ).toThrow();
  });

  it("accepts new models[] with providerKey", () => {
    const s = validateSettings({
      providers: [
        { key: "deepseek", kind: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKey: "k" },
      ],
      models: [
        {
          key: "ds-flash",
          providerKey: "deepseek",
          model: "deepseek-v4-flash",
          maxContextTokens: 1_000_000,
        },
      ],
    });
    expect(s.models[0].providerKey).toBe("deepseek");
  });

  it("still accepts legacy models[] entry shape (for migration)", () => {
    const s = validateSettings({
      models: [
        { key: "legacy", provider: "openai", model: "gpt-4o", apiKey: "k", baseUrl: "https://x" },
      ],
    });
    expect(s.models[0].key).toBe("legacy");
  });
});

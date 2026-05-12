import { describe, it, expect } from "bun:test";
import { migrateModels } from "../src/cli/migrate-models.js";

describe("migrateModels", () => {
  it("groups by (provider, baseUrl, apiKey) into providers[]", () => {
    const out = migrateModels({
      providers: [],
      models: [
        { key: "a", provider: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "k1", model: "deepseek-v4-flash" },
        { key: "b", provider: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "k1", model: "deepseek-chat" },
        { key: "c", provider: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k2", model: "gpt-4o" },
      ],
    });
    expect(out.changed).toBe(true);
    expect(out.providers).toHaveLength(2);
    expect(out.providers.find((p) => p.kind === "deepseek")).toBeTruthy();
    expect(out.providers.find((p) => p.kind === "openai")).toBeTruthy();
    expect(out.models.every((m) => m.providerKey && !(m as any).apiKey && !(m as any).baseUrl)).toBe(true);
  });

  it("infers kind from baseUrl", () => {
    const out = migrateModels({
      providers: [],
      models: [
        { key: "a", provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "k", model: "claude-opus-4-6" },
      ],
    });
    expect(out.providers[0].kind).toBe("anthropic");
  });

  it("falls back to custom kind when baseUrl unknown", () => {
    const out = migrateModels({
      providers: [],
      models: [
        { key: "a", provider: "openai", baseUrl: "https://my-vllm.local/v1", apiKey: "k", model: "x" },
      ],
    });
    expect(out.providers[0].kind).toBe("custom");
  });

  it("is idempotent: pre-migrated input yields changed=false", () => {
    const out = migrateModels({
      providers: [{ key: "ds", kind: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKey: "k" }],
      models: [{ key: "ds-flash", providerKey: "ds", model: "deepseek-v4-flash" }],
    });
    expect(out.changed).toBe(false);
  });

  it("does not migrate an empty config", () => {
    const out = migrateModels({ providers: [], models: [] });
    expect(out.changed).toBe(false);
  });

  it("assigns unique provider keys when multiple need same slug", () => {
    const out = migrateModels({
      providers: [],
      models: [
        { key: "a", provider: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k1", model: "gpt-4o" },
        { key: "b", provider: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k2", model: "gpt-4o" },
      ],
    });
    const keys = out.providers.map((p) => p.key).sort();
    expect(keys).toEqual(["openai", "openai-2"]);
  });
});

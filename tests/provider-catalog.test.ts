import { describe, it, expect } from "bun:test";
import { ProviderCatalog, type ProviderConfig } from "../src/llm/provider-catalog.js";

const ds: ProviderConfig = {
  key: "deepseek",
  kind: "deepseek",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "k",
};

describe("ProviderCatalog", () => {
  it("constructs from settings array", () => {
    const cat = new ProviderCatalog([ds]);
    expect(cat.list().map((p) => p.key)).toEqual(["deepseek"]);
  });

  it("get() returns by key", () => {
    const cat = new ProviderCatalog([ds]);
    expect(cat.get("deepseek")?.apiKey).toBe("k");
    expect(cat.get("nope")).toBeUndefined();
  });

  it("add() rejects duplicate key", () => {
    const cat = new ProviderCatalog([ds]);
    expect(() => cat.add(ds)).toThrow(/duplicate/i);
  });

  it("update() merges over existing entry", () => {
    const cat = new ProviderCatalog([ds]);
    cat.update("deepseek", { apiKey: "k2" });
    expect(cat.get("deepseek")?.apiKey).toBe("k2");
  });

  it("update() refuses missing key", () => {
    const cat = new ProviderCatalog([ds]);
    expect(() => cat.update("missing", { apiKey: "k2" })).toThrow();
  });

  it("remove() refuses provider with model references", () => {
    const cat = new ProviderCatalog([ds]);
    expect(() => cat.remove("deepseek", { referencedBy: ["ds-flash"] })).toThrow(/referenced/i);
  });

  it("remove() succeeds when no references", () => {
    const cat = new ProviderCatalog([ds]);
    cat.remove("deepseek", { referencedBy: [] });
    expect(cat.list()).toHaveLength(0);
  });

  it("deriveKey() returns unique slug", () => {
    const cat = new ProviderCatalog([ds]);
    expect(cat.deriveKey("deepseek")).toBe("deepseek-2");
    expect(cat.deriveKey("openai")).toBe("openai");
  });
});

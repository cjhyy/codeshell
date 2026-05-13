import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCache } from "../src/llm/model-cache.js";
import { ModelPool } from "../src/llm/model-pool.js";
import { ProviderCatalog } from "../src/llm/provider-catalog.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mpc-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ModelPool reads contextLength from cache", () => {
  it("populates maxContextTokens from cache when entry omits it", () => {
    writeCache(dir, "deepseek", [
      { id: "deepseek-v4-flash", contextLength: 1_000_000, maxOutputTokens: 8192 },
    ]);
    const cat = new ProviderCatalog([
      { key: "deepseek", kind: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKey: "k" },
    ]);
    const pool = new ModelPool([
      { key: "ds-flash", provider: "openai", model: "deepseek-v4-flash", providerKey: "deepseek" } as never,
    ]);
    pool.setProviderCatalog(cat);
    pool.setCacheDir(dir);
    pool.reloadCachedContextWindows();
    const e = pool.get("ds-flash")!;
    expect(e.maxContextTokens).toBe(1_000_000);
  });

  it("does not override an explicit maxContextTokens in the entry", () => {
    writeCache(dir, "deepseek", [
      { id: "deepseek-v4-flash", contextLength: 1_000_000, maxOutputTokens: 8192 },
    ]);
    const pool = new ModelPool([
      { key: "ds-flash", provider: "openai", model: "deepseek-v4-flash", providerKey: "deepseek", maxContextTokens: 500_000 } as never,
    ]);
    pool.setProviderCatalog(new ProviderCatalog([{ key: "deepseek", kind: "deepseek", baseUrl: "x", apiKey: "k" }]));
    pool.setCacheDir(dir);
    pool.reloadCachedContextWindows();
    const e = pool.get("ds-flash")!;
    expect(e.maxContextTokens).toBe(500_000);
  });
});

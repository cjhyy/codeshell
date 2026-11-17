import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateReceipt } from "../cost-ledger/pricing.js";
import {
  findOpenRouterModel,
  getOpenRouterModels,
  setOpenRouterLookupSupplement,
  type OpenRouterModel,
} from "./openrouter-models.js";
import {
  refreshOpenRouterCatalogOnMiss,
  registerOpenRouterCatalogCache,
  syncOpenRouterCatalogCached,
} from "./openrouter-sync.js";

const LIVE_ONLY = "example/live-only-model";
const model = (id: string): OpenRouterModel => ({
  id,
  name: id,
  created: 1,
  contextLength: 200_000,
  maxOutputTokens: 8_000,
  inputPricePerMillion: 2,
  outputPricePerMillion: 10,
  cacheReadPricePerMillion: 0.2,
  cacheWritePricePerMillion: 2.5,
  modalities: ["text"],
});
const snapshot = (fetchedAt: string) => ({
  fetchedAt,
  source: "test",
  count: 1,
  models: [model(LIVE_ONLY)],
});

describe("syncOpenRouterCatalogCached", () => {
  let dir: string;
  let cacheFile: string;
  const now = () => Date.parse("2026-11-17T12:00:00Z");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "or-sync-"));
    cacheFile = join(dir, "cache", "openrouter-models.json");
  });
  afterEach(() => {
    setOpenRouterLookupSupplement([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("prices a model missing from the curated snapshot once the live catalog is loaded", async () => {
    const usage = { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 };
    const identity = { provider: "openai", providerKind: "openrouter", model: LIVE_ONLY };
    expect(estimateReceipt(identity, usage).estimatedCostUsd).toBeNull();

    const result = await syncOpenRouterCatalogCached({
      cacheFile,
      now,
      fetchCatalog: async () => snapshot("2026-11-17T11:00:00Z"),
    });

    expect(result).toMatchObject({ ok: true, source: "network" });
    expect(estimateReceipt(identity, usage).estimatedCostUsd).toBe(2);
    // Lookup only: picker lists still come from the bundled snapshot.
    expect(getOpenRouterModels().some((m) => m.id === LIVE_ONLY)).toBe(false);
    expect(JSON.parse(readFileSync(cacheFile, "utf8")).models[0].id).toBe(LIVE_ONLY);
  });

  it("uses a fresh disk cache without fetching", async () => {
    await syncOpenRouterCatalogCached({
      cacheFile,
      now,
      fetchCatalog: async () => snapshot("2026-11-17T11:00:00Z"),
    });
    setOpenRouterLookupSupplement([]);
    const result = await syncOpenRouterCatalogCached({
      cacheFile,
      now,
      fetchCatalog: async () => {
        throw new Error("must not fetch");
      },
    });
    expect(result).toMatchObject({ ok: true, source: "cache" });
    expect(findOpenRouterModel(LIVE_ONLY)).toBeDefined();
  });

  it("falls back to a stale cache when the refresh fails", async () => {
    writeFileSync(join(dir, "stale.json"), JSON.stringify(snapshot("2026-11-10T00:00:00Z")));
    const result = await syncOpenRouterCatalogCached({
      cacheFile: join(dir, "stale.json"),
      now,
      fetchCatalog: async () => {
        throw new Error("offline");
      },
    });
    expect(result).toMatchObject({ ok: true, source: "stale-cache", error: "offline" });
    expect(findOpenRouterModel(LIVE_ONLY)).toBeDefined();
  });

  it("ignores a corrupt cache and reports a failed refresh", async () => {
    writeFileSync(join(dir, "bad.json"), "{not json");
    const result = await syncOpenRouterCatalogCached({
      cacheFile: join(dir, "bad.json"),
      now,
      fetchCatalog: async () => ({ ...snapshot("2026-11-17T11:00:00Z"), models: [] }),
    });
    expect(result).toMatchObject({ ok: false, source: "network" });
    expect(findOpenRouterModel(LIVE_ONLY)).toBeUndefined();
  });

  it("hosts read the disk cache at startup without any network", () => {
    writeFileSync(join(dir, "c.json"), JSON.stringify(snapshot("2026-11-10T00:00:00Z")));
    registerOpenRouterCatalogCache(join(dir, "c.json"));
    expect(findOpenRouterModel(LIVE_ONLY)).toBeDefined();
  });

  it("refreshes once after a real OpenRouter request misses, never for other endpoints", async () => {
    registerOpenRouterCatalogCache(cacheFile);
    let fetches = 0;
    const fetchCatalog = async () => {
      fetches += 1;
      return snapshot("2026-11-17T11:00:00Z");
    };
    // Fake or local endpoints (E2E fixtures, proxies) never trigger traffic.
    expect(
      refreshOpenRouterCatalogOnMiss(LIVE_ONLY, "http://127.0.0.1:9/api/v1", fetchCatalog),
    ).toBeUndefined();
    // Known models need no refresh.
    expect(
      refreshOpenRouterCatalogOnMiss(
        "openai/gpt-6.1-sol",
        "https://openrouter.ai/api/v1",
        fetchCatalog,
      ),
    ).toBeUndefined();
    const refresh = refreshOpenRouterCatalogOnMiss(
      LIVE_ONLY,
      "https://openrouter.ai/api/v1",
      fetchCatalog,
    );
    expect(await refresh).toMatchObject({ ok: true, source: "network" });
    expect(findOpenRouterModel(LIVE_ONLY)).toBeDefined();
    setOpenRouterLookupSupplement([]);
    expect(
      refreshOpenRouterCatalogOnMiss(LIVE_ONLY, "https://openrouter.ai/api/v1", fetchCatalog),
    ).toBeUndefined();
    expect(fetches).toBe(1);
  });

  it("never touches the network under the test runner without an injected fetcher", async () => {
    expect(await syncOpenRouterCatalogCached({ cacheFile })).toMatchObject({ source: "skipped" });
  });
});

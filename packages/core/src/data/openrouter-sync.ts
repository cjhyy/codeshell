/**
 * Runtime sync of the OpenRouter model catalog.
 *
 * Fetches openrouter.ai/api/v1/models and replaces the bundled snapshot
 * in memory for the rest of the process. Used by the /sync-models slash
 * command. To persist a sync across restarts, re-run the build (which
 * re-runs scripts/sync-models.ts).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type OpenRouterModel,
  type RawOpenRouterPricing,
  coerceSnapshot,
  openRouterPriceFields,
  setOpenRouterLookupSupplement,
  setOpenRouterSnapshot,
  getOpenRouterSnapshot,
} from "./openrouter-models.js";

const ENDPOINT = "https://openrouter.ai/api/v1/models";

interface RawModel {
  id: string;
  name?: string;
  created?: number;
  context_length?: number;
  top_provider?: { context_length?: number; max_completion_tokens?: number };
  pricing?: RawOpenRouterPricing;
  architecture?: { input_modalities?: string[] };
}

function slim(m: RawModel): OpenRouterModel {
  return {
    id: m.id,
    name: m.name ?? m.id,
    created: m.created ?? 0,
    contextLength: m.top_provider?.context_length ?? m.context_length ?? 0,
    maxOutputTokens: m.top_provider?.max_completion_tokens ?? 0,
    ...openRouterPriceFields(m.pricing),
    modalities: m.architecture?.input_modalities ?? [],
  };
}

export interface SyncResult {
  ok: boolean;
  count: number;
  error?: string;
}

type CatalogSnapshot = ReturnType<typeof getOpenRouterSnapshot>;

async function fetchOpenRouterCatalog(timeoutMs: number): Promise<CatalogSnapshot> {
  const res = await fetch(ENDPOINT, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const payload = (await res.json()) as { data?: RawModel[] };
  const models = (payload.data ?? []).map(slim).sort((a, b) => b.created - a.created);
  return { fetchedAt: new Date().toISOString(), source: ENDPOINT, count: models.length, models };
}

export async function syncOpenRouterCatalog(timeoutMs = 15_000): Promise<SyncResult> {
  try {
    const snapshot = await fetchOpenRouterCatalog(timeoutMs);
    setOpenRouterSnapshot(snapshot);
    return { ok: true, count: snapshot.count };
  } catch (err) {
    return { ok: false, count: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface CachedSyncOptions {
  /** Hosts pass `<CODE_SHELL_HOME>/cache/openrouter-models.json`. */
  cacheFile: string;
  /** A cache younger than this is used without touching the network. */
  maxAgeMs?: number;
  timeoutMs?: number;
  now?: () => number;
  /** Injected in tests; the default fetches the public model list. */
  fetchCatalog?: (timeoutMs: number) => Promise<CatalogSnapshot>;
}

export interface CachedSyncResult extends SyncResult {
  source: "cache" | "network" | "stale-cache" | "skipped";
}

const DAY_MS = 24 * 60 * 60 * 1_000;

function writeCacheAtomic(file: string, contents: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, contents, "utf-8");
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function readCachedCatalog(file: string): CatalogSnapshot | null {
  try {
    const snapshot = coerceSnapshot(JSON.parse(readFileSync(file, "utf8")));
    return snapshot.models.length > 0 && !Number.isNaN(Date.parse(snapshot.fetchedAt))
      ? snapshot
      : null;
  } catch {
    return null;
  }
}

/**
 * Long-running hosts (the desktop worker and main process) use the full
 * public catalog so pricing and context windows cover every model a user can
 * configure, not just the curated bundled snapshot. It only backs id lookups
 * (`findOpenRouterModel`); picker lists keep the bundled snapshot. Cached on
 * disk for a day; a failed refresh falls back to the stale cache, then to the
 * bundled snapshot. The cache is a whole-file replace (atomic rename), so
 * concurrent hosts at worst refresh it twice.
 */
export async function syncOpenRouterCatalogCached(
  options: CachedSyncOptions,
): Promise<CachedSyncResult> {
  const fetchCatalog = options.fetchCatalog ?? fetchOpenRouterCatalog;
  if (!options.fetchCatalog && process.env.NODE_ENV === "test") {
    return { ok: false, count: 0, source: "skipped" };
  }
  const file = options.cacheFile;
  const now = options.now ?? Date.now;
  const cached = readCachedCatalog(file);
  if (cached && now() - Date.parse(cached.fetchedAt) < (options.maxAgeMs ?? DAY_MS)) {
    setOpenRouterLookupSupplement(cached.models);
    return { ok: true, count: cached.count, source: "cache" };
  }
  try {
    const snapshot = await fetchCatalog(options.timeoutMs ?? 15_000);
    if (snapshot.models.length === 0) throw new Error("empty OpenRouter catalog");
    setOpenRouterLookupSupplement(snapshot.models);
    try {
      writeCacheAtomic(file, JSON.stringify(snapshot));
    } catch {
      // The in-memory catalog is already current; the next start refetches.
    }
    return { ok: true, count: snapshot.count, source: "network" };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (cached) {
      setOpenRouterLookupSupplement(cached.models);
      return { ok: true, count: cached.count, source: "stale-cache", error };
    }
    return { ok: false, count: 0, source: "network", error };
  }
}

export { getOpenRouterSnapshot };

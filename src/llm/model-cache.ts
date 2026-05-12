/**
 * Cache file IO for per-provider model lists.
 *
 * One file per provider key under <cacheDir>/<providerKey>.json. TTL is
 * 7 days. Callers decide whether to honor staleness — readCache just
 * reads, isStale just checks. Malformed/missing files yield undefined.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface CachedModel {
  id: string;
  contextLength: number;
  maxOutputTokens: number;
}

export interface ModelCacheFile {
  fetchedAt: string;
  providerKey: string;
  models: CachedModel[];
}

const TTL_MS = 7 * 24 * 3600 * 1000;

export function readCache(cacheDir: string, providerKey: string): ModelCacheFile | undefined {
  const path = join(cacheDir, `${providerKey}.json`);
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as ModelCacheFile;
    if (!parsed || !Array.isArray(parsed.models)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeCache(
  cacheDir: string,
  providerKey: string,
  models: CachedModel[],
): ModelCacheFile {
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const payload: ModelCacheFile = {
    fetchedAt: new Date().toISOString(),
    providerKey,
    models,
  };
  writeFileSync(join(cacheDir, `${providerKey}.json`), JSON.stringify(payload, null, 2), "utf-8");
  return payload;
}

export function isStale(file: ModelCacheFile, now: number = Date.now()): boolean {
  const ts = Date.parse(file.fetchedAt);
  if (!Number.isFinite(ts)) return true;
  return now - ts > TTL_MS;
}

export function defaultCacheDir(): string {
  return join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".code-shell",
    "cache",
    "models",
  );
}

/**
 * Model catalog assembly — merge built-in (A) + user (B) templates.
 *
 * - A: {@link BUILTIN_CATALOG} (ships with the app).
 * - B: ~/.code-shell/model-catalog.user.json (user-added templates).
 * - merge: union by `id`; same id → user B wins (so升级 doesn't clobber the
 *   user's overrides/additions).
 *
 * No remote source this version (design doc §5).
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { userHome } from "../settings/manager.js";
import { logger } from "../logging/logger.js";
import { BUILTIN_CATALOG } from "./builtin.js";
import { userCatalogFileSchema, type CatalogEntry } from "./types.js";

export type { CatalogEntry } from "./types.js";
export { BUILTIN_CATALOG } from "./builtin.js";

/** Path to the user catalog file (source B). */
export function userCatalogPath(): string {
  return join(userHome(), ".code-shell", "model-catalog.user.json");
}

/**
 * Load user-defined catalog entries (source B). Returns [] when the file is
 * absent or invalid — a bad user file must never break the built-in catalog.
 */
export function loadUserCatalog(): CatalogEntry[] {
  const path = userCatalogPath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const result = userCatalogFileSchema.safeParse(parsed);
    if (!result.success) {
      logger.warn("model_catalog_user_invalid", { path, issues: result.error.issues.length });
      return [];
    }
    return result.data;
  } catch (err) {
    logger.warn("model_catalog_user_read_failed", { path, error: (err as Error).message });
    return [];
  }
}

/**
 * Merged catalog: built-in (A) ∪ user (B), deduped by `id` with user winning.
 * This is the single source the 连接 page renders from and the tool-description
 * injector looks up `paramsDoc` in.
 */
export function getMergedCatalog(): CatalogEntry[] {
  const byId = new Map<string, CatalogEntry>();
  for (const e of BUILTIN_CATALOG) byId.set(e.id, e);
  for (const e of loadUserCatalog()) byId.set(e.id, e); // user overrides built-in
  return [...byId.values()];
}

/**
 * Look up a catalog entry by id (e.g. an instance's `catalogId`), falling back
 * to the first entry whose `adapterKind` matches `kindFallback`. Since an
 * adapterKind (e.g. "openai") can now back both a text and an image entry,
 * `tagFallback` disambiguates the fallback to the right group.
 */
export function findCatalogEntry(
  catalog: CatalogEntry[],
  id: string | undefined,
  kindFallback?: string,
  tagFallback?: CatalogEntry["tag"],
): CatalogEntry | undefined {
  if (id) {
    const exact = catalog.find((e) => e.id === id);
    if (exact) return exact;
  }
  if (kindFallback) {
    return catalog.find(
      (e) => e.adapterKind === kindFallback && (!tagFallback || e.tag === tagFallback),
    );
  }
  return undefined;
}

/**
 * saveCatalogEntry — backup + validate + upsert-write one CatalogEntry into a
 * user catalog file. Safe: backs up any existing (even corrupt) file first,
 * validates the entry against the schema, and only writes on success. The
 * agent-facing catalog edit tool wraps this; key/credentials are NOT touched
 * here (those go through the user's own Edit, by design).
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §7.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { catalogEntrySchema, userCatalogFileSchema, type CatalogEntry } from "./types.js";
import { upsertCatalogEntry } from "./upsert.js";

export interface SaveCatalogResult {
  ok: boolean;
  action?: "added" | "updated";
  error?: string;
  backup?: string;
}

/**
 * @param stamp caller-supplied unique suffix for the backup filename. Pass a
 *   timestamp/counter from the caller — core forbids Date.now() in some paths
 *   and tests need determinism.
 */
export function saveCatalogEntry(
  entry: unknown,
  opts: { path: string; stamp: string },
): SaveCatalogResult {
  // Validate the incoming entry first — never write a malformed catalog.
  const parsed = catalogEntrySchema.safeParse(entry);
  if (!parsed.success) {
    return { ok: false, error: `invalid catalog entry: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const valid: CatalogEntry = parsed.data;

  // Read + back up any existing file (even if corrupt — never silently lose it).
  let current: CatalogEntry[] = [];
  let backup: string | undefined;
  if (existsSync(opts.path)) {
    backup = `${opts.path}.bak-${opts.stamp}`;
    try {
      copyFileSync(opts.path, backup);
    } catch {
      backup = undefined; // best-effort; don't abort the write on backup failure
    }
    try {
      const raw = JSON.parse(readFileSync(opts.path, "utf-8"));
      const safe = userCatalogFileSchema.safeParse(raw);
      current = safe.success ? safe.data : [];
    } catch {
      current = []; // corrupt → start fresh (original preserved in backup)
    }
  }

  const action: "added" | "updated" = current.some((e) => e.id === valid.id) ? "updated" : "added";
  const next = upsertCatalogEntry(current, valid);
  writeFileSync(opts.path, JSON.stringify(next, null, 2));
  return { ok: true, action, backup };
}

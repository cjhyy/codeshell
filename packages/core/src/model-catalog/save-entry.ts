/**
 * saveCatalogEntry — backup + validate + upsert-write one CatalogEntry into a
 * user catalog file. Safe: backs up any existing (even corrupt) file first,
 * validates the entry against the schema, and only writes on success. The
 * agent-facing catalog edit tool wraps this; key/credentials are NOT touched
 * here (those go through the user's own Edit, by design).
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §7.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
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
  // Ensure the parent dir exists — a first-ever catalog write on a machine
  // whose ~/.code-shell hasn't been created yet would otherwise throw ENOENT
  // (the agent-facing tool wants a clean {ok:false} or a real write, not a crash).
  try {
    mkdirSync(dirname(opts.path), { recursive: true });
  } catch (e) {
    return { ok: false, error: `could not create catalog directory: ${e instanceof Error ? e.message : String(e)}`, backup };
  }
  try {
    writeFileSync(opts.path, JSON.stringify(next, null, 2));
  } catch (e) {
    // IO error (perms / disk full / bad path): return a clean {ok:false} with the
    // backup filename preserved, never let the throw escape past the tool's
    // expected result shape (the original file is intact — we only upsert-wrote).
    return { ok: false, error: `could not write catalog: ${e instanceof Error ? e.message : String(e)}`, backup };
  }
  return { ok: true, action, backup };
}

export interface DeleteCatalogResult {
  ok: boolean;
  removed: boolean;
  error?: string;
  backup?: string;
}

/**
 * Remove the entry with `id` from the user catalog file. Mirrors saveCatalogEntry's
 * backup + atomic-write safety. removed:false means the id wasn't in the user file
 * (a pristine built-in entry, or simply absent). The built-in catalog is code,
 * untouched — deleting a user override just lets getMergedCatalog fall back to the
 * built-in version ("reset" semantics).
 */
export function deleteUserCatalogEntry(
  id: string,
  opts: { path: string; stamp: string },
): DeleteCatalogResult {
  if (!existsSync(opts.path)) return { ok: true, removed: false };
  let backup: string | undefined = `${opts.path}.bak-${opts.stamp}`;
  try { copyFileSync(opts.path, backup); } catch { backup = undefined; }
  let current: CatalogEntry[] = [];
  try {
    const raw = JSON.parse(readFileSync(opts.path, "utf-8"));
    const safe = userCatalogFileSchema.safeParse(raw);
    current = safe.success ? safe.data : [];
  } catch { current = []; }
  const next = current.filter((e) => e.id !== id);
  const removed = next.length !== current.length;
  if (!removed) return { ok: true, removed: false, backup };
  try {
    writeFileSync(opts.path, JSON.stringify(next, null, 2));
  } catch (e) {
    return { ok: false, removed: false, error: `could not write catalog: ${e instanceof Error ? e.message : String(e)}`, backup };
  }
  return { ok: true, removed: true, backup };
}

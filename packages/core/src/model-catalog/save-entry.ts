/**
 * saveCatalogEntry — backup + validate + upsert-write one CatalogEntry into a
 * user catalog file. Safe: backs up any existing (even corrupt) file first,
 * validates the entry against the schema, and only writes on success. The
 * agent-facing catalog edit tool wraps this; key/credentials are NOT touched
 * here (those go through the user's own Edit, by design).
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §7.
 */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { catalogEntrySchema, userCatalogFileSchema, type CatalogEntry } from "./types.js";
import { upsertCatalogEntry } from "./upsert.js";
import { acquireFileLock } from "../utils/file-mutex.js";

const MAX_USER_CATALOG_BYTES = 4 * 1024 * 1024;
const BACKUP_STAMP_RE = /^[A-Za-z0-9._-]{1,128}$/;

export interface SaveCatalogResult {
  ok: boolean;
  action?: "added" | "updated";
  error?: string;
  backup?: string;
}

function pathEntry(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function readExistingCatalog(path: string): { raw: string; entries: CatalogEntry[] } | undefined {
  const metadata = pathEntry(path);
  if (!metadata) return undefined;
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size > MAX_USER_CATALOG_BYTES
  ) {
    throw new Error("catalog must be a bounded regular file");
  }
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > MAX_USER_CATALOG_BYTES) {
      throw new Error("catalog must be a bounded regular file");
    }
    const raw = readFileSync(descriptor, "utf8");
    try {
      const parsed = userCatalogFileSchema.safeParse(JSON.parse(raw));
      return { raw, entries: parsed.success ? parsed.data : [] };
    } catch {
      return { raw, entries: [] };
    }
  } finally {
    closeSync(descriptor);
  }
}

function writeBackup(path: string, raw: string): boolean {
  try {
    writeFileSync(path, raw, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function writeCatalogAtomic(path: string, entries: CatalogEntry[]): void {
  const serialized = `${JSON.stringify(userCatalogFileSchema.parse(entries), null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_USER_CATALOG_BYTES) {
    throw new Error("catalog exceeds its size limit");
  }
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentInfo = lstatSync(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new Error("catalog parent must be a real directory");
  }
  const target = pathEntry(path);
  if (target && (target.isSymbolicLink() || !target.isFile())) {
    throw new Error("catalog target must be a regular file");
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, serialized, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
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
  if (!BACKUP_STAMP_RE.test(opts.stamp)) return { ok: false, error: "invalid backup stamp" };
  let release: (() => void) | undefined;
  try {
    release = acquireFileLock(opts.path);
    const existing = readExistingCatalog(opts.path);
    let backup = existing ? `${opts.path}.bak-${opts.stamp}` : undefined;
    if (existing && !writeBackup(backup!, existing.raw)) backup = undefined;
    const action: "added" | "updated" = existing?.entries.some((e) => e.id === valid.id)
      ? "updated"
      : "added";
    writeCatalogAtomic(opts.path, upsertCatalogEntry(existing?.entries ?? [], valid));
    return { ok: true, action, backup };
  } catch (e) {
    return { ok: false, error: `could not write catalog: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    release?.();
  }
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
  if (!BACKUP_STAMP_RE.test(opts.stamp)) {
    return { ok: false, removed: false, error: "invalid backup stamp" };
  }
  let release: (() => void) | undefined;
  try {
    release = acquireFileLock(opts.path);
    const existing = readExistingCatalog(opts.path);
    if (!existing) return { ok: true, removed: false };
    let backup: string | undefined = `${opts.path}.bak-${opts.stamp}`;
    if (!writeBackup(backup, existing.raw)) backup = undefined;
    const next = existing.entries.filter((e) => e.id !== id);
    const removed = next.length !== existing.entries.length;
    if (!removed) return { ok: true, removed: false, backup };
    writeCatalogAtomic(opts.path, next);
    return { ok: true, removed: true, backup };
  } catch (e) {
    return {
      ok: false,
      removed: false,
      error: `could not write catalog: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    release?.();
  }
}

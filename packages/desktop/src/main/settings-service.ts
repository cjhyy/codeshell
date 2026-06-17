/**
 * Read/write code-shell settings.json files.
 *
 * Scopes:
 *   - user:    ~/.code-shell/settings.json
 *   - project: <cwd>/.code-shell/settings.json (when cwd given)
 *
 * Returns null when the file doesn't exist; updateSettings creates
 * the file (and dir) atomically via a temp + rename.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { lock } from "@cjhyy/code-shell-core";

export type SettingsScope = "user" | "project";

export interface SettingsLocation {
  scope: SettingsScope;
  path: string;
}

export function resolveSettingsPath(scope: SettingsScope, cwd?: string): string {
  if (scope === "user") return path.join(os.homedir(), ".code-shell", "settings.json");
  if (!cwd) throw new Error("project scope requires cwd");
  return path.join(cwd, ".code-shell", "settings.json");
}

export async function readSettings(
  scope: SettingsScope,
  cwd?: string,
): Promise<Record<string, unknown> | null> {
  const p = resolveSettingsPath(scope, cwd);
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Corrupt settings.json (crash mid-write, manual mis-edit, half-written
    // disk). Don't throw — that would reject settings:get and break the whole
    // settings page (and every subsequent settings:set, since writeSettings
    // also reads first). Degrade to "no settings" so the UI renders defaults
    // and the user's next write overwrites the bad file. Back up the corrupt
    // file once for post-mortem.
    try {
      await fs.rename(p, p + ".corrupt-" + Date.now());
    } catch { /* best effort */ }
    return null;
  }
}

// Concurrency for writeSettings (a read-modify-write) is guarded at TWO levels:
//
//   1. writeChains — per-path promise chain. Serializes writes WITHIN this
//      process (rapid toggle flips, multiple BrowserWindows of one Electron
//      main). Cheap, in-memory; also means same-process writes never contend
//      for the OS lock below.
//
//   2. lock(dir) — cross-process advisory file lock (proper-lockfile, the same
//      one CronStore uses for cron.json). This is what stops the agent WORKER
//      process — or a second Electron instance — from doing its own RMW between
//      our read and our rename and silently dropping our update. The lock is on
//      the .code-shell DIRECTORY (it always exists after mkdir; settings.json
//      may not), matching CronStore.
//
// Advisory = only writers that take this lock are mutually exclusive, so
// writeSettings MUST be the only path that writes settings.json. Do not bypass.
const writeChains = new Map<string, Promise<void>>();

// stale: a holder that crashes (kill -9 / power loss) must not wedge writes
// forever; 10s ≫ any real settings write, so it won't be falsely reclaimed.
// retries: settings writes want "don't lose my change" over "fail fast", so
// wait through a brief contention window with backoff rather than erroring.
const LOCK_STALE_MS = 10_000;
const LOCK_RETRIES = { retries: 10, factor: 1.5, minTimeout: 20, maxTimeout: 500 };

export async function writeSettings(
  scope: SettingsScope,
  patch: Record<string, unknown>,
  cwd?: string,
): Promise<void> {
  const p = resolveSettingsPath(scope, cwd);
  // Serialize per file. Tail off the previous write (ignoring its rejection so
  // one failure doesn't poison the chain) before doing our read-modify-write.
  const prev = writeChains.get(p) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const dir = path.dirname(p);
    await fs.mkdir(dir, { recursive: true });
    // Cross-process lock around the whole RMW. Lock the dir, not the file.
    const release = await lock(dir, { stale: LOCK_STALE_MS, retries: LOCK_RETRIES });
    try {
      const current = (await readSettings(scope, cwd)) ?? {};
      const merged = deepMerge(current, patch);
      // Unique temp name so a concurrent writer for the same file can't clobber
      // our half-written temp and produce corrupt JSON after rename.
      const tmp = p + "." + randomUUID() + ".tmp";
      await fs.writeFile(tmp, JSON.stringify(merged, null, 2) + "\n", "utf8");
      await fs.rename(tmp, p);
    } finally {
      await release();
    }
  });
  writeChains.set(p, next);
  try {
    await next;
  } finally {
    // Clear the chain entry once it's the tail, so the map doesn't grow.
    if (writeChains.get(p) === next) writeChains.delete(p);
  }
}

function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === null) {
      delete out[k];
    } else if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof out[k] === "object" &&
      out[k] !== null &&
      !Array.isArray(out[k])
    ) {
      out[k] = deepMerge(
        out[k] as Record<string, unknown>,
        v as Record<string, unknown>,
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

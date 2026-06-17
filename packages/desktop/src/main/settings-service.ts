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

// Per-path serialization: writeSettings is a read-modify-write, so concurrent
// settings:set calls (rapid toggle flips, or set racing a worker write) would
// otherwise lose updates or interleave temp files. Chain writes for the same
// file behind a promise so each one reads the previous one's result.
const writeChains = new Map<string, Promise<void>>();

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
    const current = (await readSettings(scope, cwd)) ?? {};
    const merged = deepMerge(current, patch);
    // Unique temp name so a concurrent writer for the same file (e.g. the
    // worker process) can't clobber our half-written temp and produce corrupt
    // JSON after rename.
    const tmp = p + "." + randomUUID() + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(merged, null, 2) + "\n", "utf8");
    await fs.rename(tmp, p);
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

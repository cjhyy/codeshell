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
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function writeSettings(
  scope: SettingsScope,
  patch: Record<string, unknown>,
  cwd?: string,
): Promise<void> {
  const p = resolveSettingsPath(scope, cwd);
  const dir = path.dirname(p);
  await fs.mkdir(dir, { recursive: true });
  const current = (await readSettings(scope, cwd)) ?? {};
  const merged = deepMerge(current, patch);
  const tmp = p + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(merged, null, 2) + "\n", "utf8");
  await fs.rename(tmp, p);
}

function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (
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

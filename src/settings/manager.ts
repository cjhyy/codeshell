/**
 * Settings manager — multi-source loading and merge.
 *
 * Priority: CLI flags > local > project > user > managed
 */

import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  copyFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { validateSettings, type ValidatedSettings } from "./schema.js";
import { migrateModels } from "../cli/migrate-models.js";

/**
 * Resolve the user's home directory. Prefers `process.env.HOME` so that
 * runtime env overrides (set after process start, e.g. in tests) actually
 * take effect — on some runtimes (e.g. Bun on macOS) `os.homedir()` is
 * cached from the user database at process startup and ignores later
 * `process.env.HOME` mutations.
 */
function userHome(): string {
  return process.env.HOME ?? homedir();
}

export type SettingsSourceName = "managed" | "user" | "project" | "local" | "flag";

interface SettingsSource {
  name: SettingsSourceName;
  priority: number;
  data: Record<string, unknown>;
}

export class SettingsManager {
  private sources: SettingsSource[] = [];
  private merged: ValidatedSettings | null = null;

  constructor(private readonly cwd: string = process.cwd()) {}

  /**
   * Load settings from all sources.
   */
  load(flagOverrides?: Record<string, unknown>): ValidatedSettings {
    this.sources = [];

    // 1. Managed (lowest priority)
    this.loadJsonFile(join(userHome(), ".code-shell", "settings.managed.json"), "managed", 0);

    // 2. User — check both ~/.code-shell/ and ~/.claude/ (compat)
    this.loadJsonFile(join(userHome(), ".code-shell", "settings.json"), "user", 1);
    this.loadJsonFile(join(userHome(), ".claude", "settings.json"), "user", 1);

    // 3. Project
    this.loadJsonFile(join(this.cwd, ".code-shell", "settings.json"), "project", 2);
    this.loadJsonFile(join(this.cwd, ".claude", "settings.json"), "project", 2);

    // 4. Local
    this.loadJsonFile(join(this.cwd, ".code-shell", "settings.local.json"), "local", 3);
    this.loadJsonFile(join(this.cwd, ".claude", "settings.local.json"), "local", 3);

    // 5. CLI flags (highest priority)
    if (flagOverrides && Object.keys(flagOverrides).length > 0) {
      this.sources.push({ name: "flag", priority: 4, data: flagOverrides });
    }

    // Sort by priority ascending (merge in order, later wins)
    this.sources.sort((a, b) => a.priority - b.priority);

    // Deep merge
    const raw = this.deepMerge();

    // Auto-migrate legacy models[] in the user settings file. Runs directly
    // on the user-scope file (not the merged result), because the merge
    // collapses provenance and the migration needs to write back to a
    // single physical file.
    const userPath = join(userHome(), ".code-shell", "settings.json");
    if (existsSync(userPath)) {
      try {
        const userRaw = JSON.parse(readFileSync(userPath, "utf-8")) as Record<string, unknown>;
        const result = migrateModels({
          providers: (userRaw.providers as never) ?? [],
          models: (userRaw.models as never) ?? [],
        });
        if (result.changed) {
          copyFileSync(userPath, `${userPath}.bak`);
          const migrated = {
            ...userRaw,
            providers: result.providers,
            models: result.models,
          };
          writeFileSync(userPath, JSON.stringify(migrated, null, 2), "utf-8");
          // Re-deep-merge with the migrated user data so the validate
          // call sees the new shape rather than the legacy one.
          const userSource = this.sources.find((s) => s.name === "user");
          if (userSource) userSource.data = migrated;
          const remerged = this.deepMerge();
          this.merged = validateSettings(remerged);
          return this.merged;
        }
      } catch {
        // Migration is best-effort — fall through to normal validate.
      }
    }

    this.merged = validateSettings(raw);
    return this.merged;
  }

  /**
   * Get current effective settings.
   */
  get(): ValidatedSettings {
    if (!this.merged) return this.load();
    return this.merged;
  }

  /**
   * Invalidate cached merge.
   */
  invalidate(): void {
    this.merged = null;
  }

  /**
   * Persist a single setting (dotted key path) to the user-level config file
   * at ~/.code-shell/settings.json. Other sources (project / local /
   * managed) are intentionally untouched: writing back to project/local
   * would surprise version control, and managed is read-only.
   *
   * The merged cache is invalidated so the next get() picks up the change.
   */
  saveUserSetting(key: string, value: unknown): void {
    const path = join(userHome(), ".code-shell", "settings.json");
    let current: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          current = parsed;
        }
      } catch {
        // Corrupt file — overwrite rather than crash.
      }
    }

    const parts = key.split(".");
    let target: Record<string, unknown> = current;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      const next = target[seg];
      if (!next || typeof next !== "object" || Array.isArray(next)) {
        target[seg] = {};
      }
      target = target[seg] as Record<string, unknown>;
    }
    target[parts[parts.length - 1]!] = value;

    mkdirSync(dirname(path), { recursive: true });
    // Atomic write: stage to .tmp, then rename, so a concurrent read can't
    // catch a half-written file.
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(current, null, 2), "utf-8");
    renameSync(tmp, path);

    this.invalidate();
  }

  private loadJsonFile(path: string, name: SettingsSourceName, priority: number): void {
    if (!existsSync(path)) return;
    try {
      const content = readFileSync(path, "utf-8");
      const data = JSON.parse(content);
      if (typeof data === "object" && data !== null) {
        this.sources.push({ name, priority, data });
      }
    } catch {
      // Skip invalid files
    }
  }

  private deepMerge(): Record<string, unknown> {
    let result: Record<string, unknown> = {};
    for (const source of this.sources) {
      result = merge(result, source.data);
    }
    return result;
  }
}

function merge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };

  for (const [key, value] of Object.entries(override)) {
    if (value === null) {
      delete result[key];
    } else if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key]) &&
      result[key] !== null
    ) {
      result[key] = merge(result[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  return result;
}

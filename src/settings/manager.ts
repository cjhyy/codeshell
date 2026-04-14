/**
 * Settings manager — multi-source loading and merge.
 *
 * Priority: CLI flags > local > project > user > managed
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { validateSettings, type ValidatedSettings } from "./schema.js";

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
    this.loadJsonFile(join(homedir(), ".code-shell", "settings.managed.json"), "managed", 0);

    // 2. User — check both ~/.code-shell/ and ~/.claude/ (compat)
    this.loadJsonFile(join(homedir(), ".code-shell", "settings.json"), "user", 1);
    this.loadJsonFile(join(homedir(), ".claude", "settings.json"), "user", 1);

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

function merge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
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
      result[key] = merge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}

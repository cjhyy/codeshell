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
import { migrateModels } from "../migrate-models.js";

/**
 * Resolve the user's home directory. Prefers `process.env.HOME` so that
 * runtime env overrides (set after process start, e.g. in tests) actually
 * take effect — on some runtimes (e.g. Bun on macOS) `os.homedir()` is
 * cached from the user database at process startup and ignores later
 * `process.env.HOME` mutations.
 */
export function userHome(): string {
  return process.env.HOME ?? homedir();
}

export type SettingsSourceName = "managed" | "user" | "project" | "local" | "flag";

/**
 * Which disk layers a SettingsManager is allowed to read.
 *   'full'     — managed + user (~/.code-shell) + project + local (host terminal entrypoints)
 *   'project'  — project + local only (${cwd}/.code-shell); never the host user dir. [default]
 *   'isolated' — no disk layers at all; only explicit flag overrides.
 * Flag overrides always apply regardless of scope. Default is 'project' so a
 * codeshell library/SDK embedding never silently inherits the host user's
 * personal ~/.code-shell config (keys, models, MCP servers, hooks).
 */
export type SettingsScope = "isolated" | "project" | "full";

interface SettingsSource {
  name: SettingsSourceName;
  priority: number;
  data: Record<string, unknown>;
}

export class SettingsManager {
  private sources: SettingsSource[] = [];
  private merged: ValidatedSettings | null = null;

  constructor(
    private readonly cwd: string = process.cwd(),
    private readonly scope: SettingsScope = "project",
  ) {}

  /**
   * Load settings from all sources.
   */
  load(flagOverrides?: Record<string, unknown>): ValidatedSettings {
    this.sources = [];

    // Scope gates which disk layers we read. 'full' reads the host user dir
    // (~/.code-shell); 'project' and 'isolated' never do. See SettingsScope.
    const readUser = this.scope === "full";
    const readProject = this.scope !== "isolated";

    if (readUser) {
      // 1. Managed (lowest priority)
      this.loadJsonFile(join(userHome(), ".code-shell", "settings.managed.json"), "managed", 0);

      // 2. User — only ~/.code-shell/. We used to also read ~/.claude/settings.json
      // for "zero-migration from Claude Code", but Claude Code's schema diverges
      // (e.g. `model` is a string there, an object here). Merging caused boot
      // crashes on machines that had Claude Code installed but never ran us.
      // File-level compat (CLAUDE.md, .claude/skills/) is kept elsewhere — only
      // the settings.json read is dropped.
      this.loadJsonFile(join(userHome(), ".code-shell", "settings.json"), "user", 1);
    }

    if (readProject) {
      // 3. Project
      this.loadJsonFile(join(this.cwd, ".code-shell", "settings.json"), "project", 2);

      // 4. Local
      this.loadJsonFile(join(this.cwd, ".code-shell", "settings.local.json"), "local", 3);
    }

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
    // single physical file. Gated on readUser: under non-full scope we must
    // not read — let alone rewrite — the host's ~/.code-shell/settings.json.
    const userPath = join(userHome(), ".code-shell", "settings.json");
    if (readUser && existsSync(userPath)) {
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

  /**
   * Persist a single setting (dotted key path) to the PROJECT-level config
   * file at ${cwd}/.code-shell/settings.json. This is where capabilityOverrides
   * live — project overlays never touch the global user file. Atomic write +
   * cache invalidation mirror saveUserSetting.
   */
  saveProjectSetting(key: string, value: unknown, cwd: string): void {
    // projectSettingsPath throws on an empty cwd (boundary guard) — keep that.
    const path = this.projectSettingsPath(cwd);
    // Don't resurrect a deleted project root: atomicWriteJson's recursive mkdir
    // of <cwd>/.code-shell recreates `cwd` itself as an empty shell when cwd is
    // gone. A non-empty cwd that no longer exists means the project was deleted
    // — skip the write rather than recreate it.
    if (!existsSync(cwd)) return;
    const current = this.readJsonObject(path);
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
    this.atomicWriteJson(path, current);
    this.invalidate();
  }

  /**
   * Delete a single dotted key from the PROJECT-level config file. Used to
   * express "inherit" — we don't persist the literal "inherit"; we remove the
   * override key. No-ops if the file or any intermediate segment is absent.
   */
  deleteProjectSetting(key: string, cwd: string): void {
    const path = this.projectSettingsPath(cwd);
    if (!existsSync(path)) return;
    const current = this.readJsonObject(path);
    const parts = key.split(".");
    let target: Record<string, unknown> | undefined = current;
    for (let i = 0; i < parts.length - 1; i++) {
      const next = target?.[parts[i]!];
      if (!next || typeof next !== "object" || Array.isArray(next)) return;
      target = next as Record<string, unknown>;
    }
    if (target) delete target[parts[parts.length - 1]!];
    this.atomicWriteJson(path, current);
    this.invalidate();
  }

  /**
   * Read ONE scope's raw settings file, validated but UNMERGED. Capability
   * overlay math needs the project overlay and the user/global baseline
   * separately — the merged get() collapses provenance and can't express
   * tri-state inheritance. user → ~/.code-shell/settings.json, project →
   * ${cwd}/.code-shell/settings.json. Only keys actually present in the file
   * are returned (defaults are not synthesized), so an absent file → {}.
   */
  getForScope(scope: "user" | "project", cwd?: string): Partial<ValidatedSettings> {
    const path =
      scope === "user"
        ? join(userHome(), ".code-shell", "settings.json")
        : this.projectSettingsPath(cwd ?? this.cwd);
    const raw = this.readJsonObject(path);
    // validateSettings applies defaults; for a scope view we want only the
    // file's own keys, so validate then project back the present keys.
    const validated = validateSettings(raw) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(raw)) out[k] = validated[k];
    return out as Partial<ValidatedSettings>;
  }

  private projectSettingsPath(cwd: string): string {
    if (!cwd || cwd.trim().length === 0) {
      throw new Error("project setting write requires a non-empty cwd");
    }
    return join(cwd, ".code-shell", "settings.json");
  }

  private readJsonObject(path: string): Record<string, unknown> {
    if (!existsSync(path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt file — overwrite rather than crash.
    }
    return {};
  }

  private atomicWriteJson(path: string, data: Record<string, unknown>): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmp, path);
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

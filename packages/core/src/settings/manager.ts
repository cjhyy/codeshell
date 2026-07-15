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
import { join, dirname, extname } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { validateSettings, type ValidatedSettings } from "./schema.js";
import { migrateModels } from "../migrate-models.js";
import { migrateConfig, CONFIG_VERSION_KEY } from "./migrate-config.js";

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

/**
 * Settings keys that form the trust/permission root and therefore must NOT be
 * writable through the generic `config_set` / provider-agnostic write path.
 * A protocol peer (external driver, paired phone, or a compromised renderer)
 * can send arbitrary config writes; letting it set these would be equivalent to
 * remotely disabling the workspace-trust / permission model:
 *   - permissions      → self-authorize any tool (permissions.rules / defaultMode)
 *   - env / localEnvironment → inject BASH_ENV / NODE_OPTIONS / LD_PRELOAD / PATH
 *   - hooks            → run arbitrary commands on tool events
 *   - mcpServers / mcpServerOverrides → point tools at attacker-controlled servers
 * These are only meant to be changed by the local settings UI (a trusted write
 * path) or by hand-editing the file, never by a generic remote config write.
 */
const PROTECTED_SETTING_ROOTS = new Set([
  "permissions",
  "env",
  "localEnvironment",
  "hooks",
  "mcpServers",
  "mcpServerOverrides",
]);

/**
 * True if `key` (a dotted path like "permissions.rules" or just "env") targets a
 * protected trust-root field. Matches on the FIRST segment so nested writes
 * ("permissions.defaultMode", "env.FOO") are caught too.
 */
export function isProtectedSettingKey(key: string): boolean {
  const root = key.split(".")[0] ?? "";
  return PROTECTED_SETTING_ROOTS.has(root);
}

const FORBIDDEN_SETTING_KEY_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function isForbiddenSettingKeySegment(key: string): boolean {
  return FORBIDDEN_SETTING_KEY_SEGMENTS.has(key);
}

function parseDottedSettingKey(key: string): string[] {
  const parts = key.split(".");
  if (
    parts.length === 0 ||
    parts.some((seg) => seg.length === 0 || isForbiddenSettingKeySegment(seg))
  ) {
    throw new Error(`invalid setting key: ${key}`);
  }
  return parts;
}

function sanitizeSettingsValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeSettingsValue(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isForbiddenSettingKeySegment(key)) continue;
    out[key] = sanitizeSettingsValue(child);
  }
  return out;
}

function sanitizeSettingsObject(data: Record<string, unknown>): Record<string, unknown> {
  return sanitizeSettingsValue(data) as Record<string, unknown>;
}

function isOwnPlainObject(
  parent: Record<string, unknown>,
  key: string,
): parent is Record<string, Record<string, unknown>> {
  if (!Object.prototype.hasOwnProperty.call(parent, key)) return false;
  const value = parent[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function descendForSettingWrite(
  target: Record<string, unknown>,
  key: string,
  fullKey: string,
): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(target, key)) {
    const inherited = target[key];
    if (inherited && typeof inherited === "object") {
      throw new Error(
        `invalid setting key: ${fullKey} (refusing to descend through inherited object segment: ${key})`,
      );
    }
    target[key] = {};
  } else if (!isOwnPlainObject(target, key)) {
    target[key] = {};
  }
  return target[key] as Record<string, unknown>;
}

export function setDottedSetting(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  const parts = parseDottedSettingKey(key);
  let current: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    current = descendForSettingWrite(current, parts[i]!, key);
  }
  current[parts[parts.length - 1]!] = value;
}

/**
 * The fixed cwd used for "no-repo" pure-chat conversations (a chat not bound to
 * any code project). Same location as desktop's `resolveNoRepoCwd`
 * (`join(homedir(), ".code-shell", "no-repo")`), but built from {@link userHome}
 * so tests can isolate it by overriding `$HOME`. The engine compares
 * `config.cwd === noRepoDir()` to flip skill/plugin filtering to whitelist mode.
 */
export function noRepoDir(): string {
  return join(userHome(), ".code-shell", "no-repo");
}

export type SettingsSourceName = "managed" | "user" | "project" | "local" | "flag";

/**
 * Top-level settings fields that can influence code execution and are therefore
 * stripped from an UNTRUSTED project's disk layers (project + local) before
 * merge. A repo commits these into its `.code-shell/settings.json`, so an
 * untrusted clone must not have them take effect:
 *   - permissions  — `rules` can self-authorize (allow Bash …); `defaultMode`
 *                     can set bypassPermissions.
 *   - env          — injected into Bash child env unfiltered (BASH_ENV,
 *                     LD_PRELOAD, PATH → arbitrary code on next command).
 *   - localEnvironment — same, as the env floor.
 *   - hooks        — arbitrary commands on lifecycle events.
 *   - mcpServers   — auto-connect to attacker-controlled MCP servers.
 * Only project-scoped layers are filtered; user/managed/flag are trusted.
 * Mirrors Claude Code's TRUSTED_SETTING_SOURCES model (project sources excluded
 * from dangerous env application until trust is granted).
 */
export const DANGEROUS_PROJECT_FIELDS = [
  "permissions",
  "env",
  "localEnvironment",
  "hooks",
  "mcpServers",
] as const;

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
    /**
     * Workspace trust for the project directory. When false, dangerous fields
     * committed into the project's own `.code-shell/settings.{json,local.json}`
     * ({@link DANGEROUS_PROJECT_FIELDS}) are stripped before merge, so a cloned
     * malicious repo can't self-authorize permission rules, inject `env`
     * (BASH_ENV/LD_PRELOAD/…), register hooks, or connect MCP servers. Safe
     * fields (model choice, UI prefs, …) still merge. The user/managed/flag
     * layers are never gated — the user put those there deliberately.
     *
     * Defaults to `true` so existing embedders/tests keep their behavior; the
     * host (desktop) passes the real trust decision from its trust-store.
     */
    private readonly projectTrusted: boolean = true,
    /**
     * Override the user-level config directory (the `~/.code-shell` layer:
     * settings.managed.json / settings.json live directly inside it). When
     * absent the manager keeps today's behavior — `join(userHome(),
     * ".code-shell")` resolved per call so `$HOME` overrides still work.
     * Injection point for identity-scoped server deployments (a per-user
     * worker passes `<dataRoot>` here instead of relocating `$HOME`).
     */
    private readonly userConfigDirOverride?: string,
  ) {}

  /** User-layer config dir: explicit override wins, else `~/.code-shell`. */
  private userConfigDir(): string {
    return this.userConfigDirOverride ?? join(userHome(), ".code-shell");
  }

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
      this.loadJsonFile(join(this.userConfigDir(), "settings.managed.json"), "managed", 0);

      // 2. User — only ~/.code-shell/. We used to also read ~/.claude/settings.json
      // for "zero-migration from Claude Code", but Claude Code's schema diverges
      // (e.g. `model` is a string there, an object here). Merging caused boot
      // crashes on machines that had Claude Code installed but never ran us.
      // File-level compat (CLAUDE.md, .claude/skills/) is kept elsewhere — only
      // the settings.json read is dropped.
      this.loadJsonFile(join(this.userConfigDir(), "settings.json"), "user", 1);
    }

    if (readProject) {
      // 3. Project
      this.loadJsonFile(join(this.cwd, ".code-shell", "settings.json"), "project", 2);

      // 4. Local
      this.loadJsonFile(join(this.cwd, ".code-shell", "settings.local.json"), "local", 3);
    }

    // 5. CLI flags (highest priority)
    if (flagOverrides && Object.keys(flagOverrides).length > 0) {
      this.sources.push({ name: "flag", priority: 4, data: sanitizeSettingsObject(flagOverrides) });
    }

    // Sort by priority ascending (merge in order, later wins)
    this.sources.sort((a, b) => a.priority - b.priority);

    // Version-based config migration (migrate-config.ts), applied per physical
    // file (user + project settings.json) so the write-back lands in the file
    // the data came from. A file is only rewritten (with a .bak) when a step
    // actually changed its content — a version-stamp-only diff isn't worth
    // dirtying the user's (or a repo-tracked project) file for; steps are
    // idempotent, so re-running on unstamped files each load is fine.
    if (readUser) {
      this.applyConfigMigration(join(this.userConfigDir(), "settings.json"), "user");
    }
    if (readProject) {
      this.applyConfigMigration(join(this.cwd, ".code-shell", "settings.json"), "project");
    }

    // Workspace-trust gate: an untrusted project must not influence execution
    // through dangerous fields committed into its own .code-shell/settings.*.
    // Strip them from the project/local layers (after migration re-read the
    // files, so we filter the final data) before merge. See
    // DANGEROUS_PROJECT_FIELDS and the `projectTrusted` ctor arg.
    if (!this.projectTrusted) {
      for (const source of this.sources) {
        if (source.name !== "project" && source.name !== "local") continue;
        for (const field of DANGEROUS_PROJECT_FIELDS) {
          if (field in source.data) delete source.data[field];
        }
      }
    }

    // Deep merge
    const raw = this.deepMerge();

    // Auto-migrate legacy models[] in the user settings file. Runs directly
    // on the user-scope file (not the merged result), because the merge
    // collapses provenance and the migration needs to write back to a
    // single physical file. Gated on readUser: under non-full scope we must
    // not read — let alone rewrite — the host's ~/.code-shell/settings.json.
    const userPath = join(this.userConfigDir(), "settings.json");
    if (readUser && existsSync(userPath)) {
      try {
        const userRaw = sanitizeSettingsObject(
          JSON.parse(readFileSync(userPath, "utf-8")) as Record<string, unknown>,
        );
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
          const sanitized = sanitizeSettingsObject(migrated);
          // Atomic write (tmp+rename) — a concurrent load must not see a
          // half-written file. File exists here (existsSync guard above).
          this.atomicWriteJson(userPath, sanitized);
          // Re-deep-merge with the migrated user data so the validate
          // call sees the new shape rather than the legacy one.
          const userSource = this.sources.find((s) => s.name === "user");
          if (userSource) userSource.data = sanitized;
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
   * Run the version-based migrations (migrate-config.ts MIGRATIONS) against a
   * single physical settings file. Best-effort: any read/parse/write error
   * falls through silently and the original source data is used as-is.
   * Writes back (with a .bak, like the models[] migration above) ONLY when a
   * step changed actual content — the configVersion stamp alone doesn't
   * justify touching the file. On write-back the in-memory source is updated
   * so this load() already sees the migrated shape.
   */
  private applyConfigMigration(path: string, sourceName: SettingsSourceName): void {
    if (!existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const raw = sanitizeSettingsObject(parsed as Record<string, unknown>);
      const result = migrateConfig(raw);
      if (!result.changed) return;
      // Compare content with the version stamp normalized away — stamp-only
      // changes are not persisted.
      const stripStamp = (c: Record<string, unknown>): Record<string, unknown> => {
        const { [CONFIG_VERSION_KEY]: _v, ...rest } = c;
        return rest;
      };
      if (JSON.stringify(stripStamp(raw)) === JSON.stringify(stripStamp(result.config))) return;
      copyFileSync(path, `${path}.bak`);
      // Atomic write (tmp+rename) so a concurrent load can't read a half-written
      // migrated file — matches the normal save path (atomicWriteJson). The file
      // exists here (existsSync guard above), so the recursive mkdir is a no-op.
      const sanitized = sanitizeSettingsObject(result.config as Record<string, unknown>);
      this.atomicWriteJson(path, sanitized);
      const source = this.sources.find((s) => s.name === sourceName);
      if (source) source.data = sanitized;
    } catch {
      // Best-effort — fall through to normal merge/validate.
    }
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
    const path = join(this.userConfigDir(), "settings.json");
    let current: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          current = sanitizeSettingsObject(parsed);
        }
      } catch {
        // Corrupt file — overwrite rather than crash.
      }
    }

    setDottedSetting(current, key, value);

    mkdirSync(dirname(path), { recursive: true });
    // Atomic write: stage to .tmp, then rename, so a concurrent read can't
    // catch a half-written file. mode 0o600 — settings.json can hold plaintext
    // API keys, so it must be owner-only like credentials.json (store.ts:56),
    // not world-readable (default umask leaves 0o644 otherwise).
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(current, null, 2), { encoding: "utf-8", mode: 0o600 });
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
    setDottedSetting(current, key, value);
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
    // Must be YAML-aware, symmetric with saveProjectSetting: a project with only
    // settings.yaml has no .json, so the old `existsSync(path)` guard returned
    // here and the override survived (read/merge ARE yaml-aware → UI shows
    // "inherited" but the key still applies). readJsonObject resolves the sibling
    // YAML; the cleaned object is written back as JSON (JSON is the write-back
    // format and wins over YAML, exactly as save does).
    if (!resolveConfigPath(path)) return;
    const current = this.readJsonObject(path);
    const parts = parseDottedSettingKey(key);
    let target: Record<string, unknown> | undefined = current;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      if (!target || !isOwnPlainObject(target, seg)) return;
      target = target[seg] as Record<string, unknown>;
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
        ? join(this.userConfigDir(), "settings.json")
        : this.projectSettingsPath(cwd ?? this.cwd);
    const raw = this.readJsonObject(path);
    // validateSettings applies defaults; for a scope view we want only the
    // file's own keys, so validate then project back the present keys.
    const validated = validateSettings(raw) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(raw)) out[k] = validated[k];
    // Same workspace-trust gate as load(): getForScope("project") is a direct
    // file read that bypasses the merge, so an untrusted project's dangerous
    // fields (e.g. localEnvironment.setupScripts — shell run at worktree setup)
    // must be stripped here too. See DANGEROUS_PROJECT_FIELDS.
    if (scope === "project" && !this.projectTrusted) {
      for (const field of DANGEROUS_PROJECT_FIELDS) delete out[field];
    }
    return out as Partial<ValidatedSettings>;
  }

  private projectSettingsPath(cwd: string): string {
    if (!cwd || cwd.trim().length === 0) {
      throw new Error("project setting write requires a non-empty cwd");
    }
    return join(cwd, ".code-shell", "settings.json");
  }

  private readJsonObject(path: string): Record<string, unknown> {
    // Resolve to a sibling .yaml/.yml when the .json layer is absent so
    // scope views (getForScope) see hand-written YAML too. JSON still wins.
    const resolved = resolveConfigPath(path);
    if (!resolved) return {};
    return parseConfigFile(resolved) ?? {};
  }

  private atomicWriteJson(path: string, data: Record<string, unknown>): void {
    mkdirSync(dirname(path), { recursive: true });
    // mode 0o600: settings.json may hold plaintext API keys — owner-only, see
    // saveUserSetting above and credentials/store.ts.
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, path);
  }

  private loadJsonFile(path: string, name: SettingsSourceName, priority: number): void {
    // `path` is the canonical .json path for this layer. When it's absent but
    // a sibling settings.yaml/.yml exists, read the YAML instead (JSON wins
    // when both exist — JSON is the write-back format, YAML is hand-written).
    const resolved = resolveConfigPath(path);
    if (!resolved) return;
    const data = parseConfigFile(resolved);
    if (data) this.sources.push({ name, priority, data });
  }

  private deepMerge(): Record<string, unknown> {
    let result: Record<string, unknown> = {};
    for (const source of this.sources) {
      result = merge(result, source.data);
    }
    // Top-level `hooks` is the one array that CONCATENATES across layers
    // instead of being replaced wholesale: a user-level (global) hook and a
    // project-level hook should BOTH run, mirroring how Claude Code merges
    // hooks from all settings files. Order follows layer priority (user
    // first, project after). An explicit `"hooks": null` in a layer still
    // resets everything below it (the escape hatch merge() already gives
    // every other key); per-entry opt-out is the `disabled` field.
    let hooks: unknown[] | undefined;
    let sawHooks = false;
    for (const source of this.sources) {
      if (!("hooks" in source.data)) continue;
      const v = source.data.hooks;
      if (v === null) {
        hooks = undefined;
        sawHooks = true;
      } else if (Array.isArray(v)) {
        hooks = [...(hooks ?? []), ...v];
        sawHooks = true;
      }
      // Non-array garbage is left to merge()'s wholesale result so
      // validateSettings still sees (and rejects) it unchanged.
    }
    if (sawHooks) {
      if (hooks !== undefined) result.hooks = hooks;
      else delete result.hooks;
    }
    return result;
  }
}

/**
 * Parse a config file by extension: .yaml/.yml go through the YAML parser,
 * everything else through JSON.parse. Mirrors the loader's existing
 * "corrupt file never crashes — silently skip" contract: on any read/parse
 * error, or a non-object top-level value, returns null. The caller decides
 * what an absent/empty layer means.
 */
function parseConfigFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf-8");
    const ext = extname(path).toLowerCase();
    const parsed = ext === ".yaml" || ext === ".yml" ? parseYaml(content) : JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return sanitizeSettingsObject(parsed as Record<string, unknown>);
    }
  } catch {
    // Corrupt file — skip rather than crash.
  }
  return null;
}

/**
 * Given the JSON path for a settings layer (e.g. .../settings.json or
 * .../settings.local.json), return the path that should actually be read:
 * the .json file if it exists, otherwise a sibling .yaml/.yml if present.
 * JSON is the write-back format and wins when both exist; YAML is a
 * hand-written read-only alternative. Returns null when no layer file exists.
 */
function resolveConfigPath(jsonPath: string): string | null {
  if (existsSync(jsonPath)) return jsonPath;
  const base = jsonPath.replace(/\.json$/, "");
  for (const ext of [".yaml", ".yml"]) {
    const candidate = `${base}${ext}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function merge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(base)) {
    if (isForbiddenSettingKeySegment(key)) continue;
    result[key] = value;
  }

  for (const [key, value] of Object.entries(override)) {
    if (isForbiddenSettingKeySegment(key)) {
      continue;
    } else if (value === null) {
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

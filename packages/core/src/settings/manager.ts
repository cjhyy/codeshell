/**
 * Settings manager — multi-source loading and merge.
 *
 * Priority: CLI flags > local > project > user > managed
 */

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join, dirname, extname } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { validateSettings, type ValidatedSettings } from "./schema.js";
import { migrateModels } from "../migrate-models.js";
import { migrateConfig, CONFIG_VERSION_KEY } from "./migrate-config.js";
import { acquireFileLock, writeFileAtomic } from "../utils/file-mutex.js";

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
const MAX_SETTINGS_FILE_BYTES = 4 * 1024 * 1024;

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
      const projectPath = this.tryProjectSettingsPath(this.cwd, "settings.json");
      if (projectPath) this.loadJsonFile(projectPath, "project", 2);

      // 4. Local
      const localPath = this.tryProjectSettingsPath(this.cwd, "settings.local.json");
      if (localPath) this.loadJsonFile(localPath, "local", 3);
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
      const projectPath = this.tryProjectSettingsPath(this.cwd, "settings.json");
      if (projectPath) this.applyConfigMigration(projectPath, "project");
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
    if (readUser && resolveConfigPath(userPath) === userPath) {
      try {
        const userRaw = parseConfigFile(userPath);
        if (!userRaw) throw new Error("invalid user settings");
        const result = migrateModels({
          providers: (userRaw.providers as never) ?? [],
          models: (userRaw.models as never) ?? [],
        });
        if (result.changed) {
          this.writeBackup(userPath);
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
    if (resolveConfigPath(path) !== path) return;
    try {
      const parsed = parseConfigFile(path) as unknown;
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
      this.writeBackup(path);
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
    assertSafeSettingsWriteTarget(path);
    // Lock spans read → modify → write; see mutateSettingsFile for why the
    // atomic rename alone was not enough. This path keeps its own sanitizing
    // read (readJsonObject does not sanitize) so behaviour is unchanged apart
    // from the added serialization.
    const release = acquireFileLock(path);
    try {
      const current = parseConfigFile(path) ?? {};

      setDottedSetting(current, key, value);

      // Atomic write: stage to .tmp, then rename, so a concurrent read can't
      // catch a half-written file. mode 0o600 — settings.json can hold plaintext
      // API keys, so it must be owner-only like credentials.json (store.ts:56),
      // not world-readable (default umask leaves 0o644 otherwise).
      this.atomicWriteJson(path, current);
    } finally {
      release();
    }

    this.invalidate();
  }

  /**
   * Persist a single setting (dotted key path) to the PROJECT-level config
   * file at ${cwd}/.code-shell/settings.json. This is where capabilityOverrides
   * live — project overlays never touch the global user file. Atomic write +
   * cache invalidation mirror saveUserSetting.
   */
  saveProjectSetting(key: string, value: unknown, cwd: string): void {
    this.validateProjectCwd(cwd, "project");
    // Don't resurrect a deleted project root: atomicWriteJson's recursive mkdir
    // of <cwd>/.code-shell recreates `cwd` itself as an empty shell when cwd is
    // gone. A non-empty cwd that no longer exists means the project was deleted
    // — skip the write rather than recreate it.
    if (!existsSync(cwd)) return;
    const path = this.projectSettingsPath(cwd);
    this.mutateSettingsFile(path, (current) => {
      setDottedSetting(current, key, value);
    });
    this.invalidate();
  }

  /**
   * Persist a machine-private setting for one project. The local layer has
   * higher precedence than the shared project layer and lives at
   * `${cwd}/.code-shell/settings.local.json`, matching the file already read
   * by {@link load}. It is useful for MCP endpoints or policy that should not
   * be shared with collaborators.
   */
  saveLocalSetting(key: string, value: unknown, cwd: string): void {
    this.validateProjectCwd(cwd, "local");
    if (!existsSync(cwd)) return;
    const path = this.localSettingsPath(cwd);
    this.mutateSettingsFile(path, (current) => {
      setDottedSetting(current, key, value);
    });
    this.invalidate();
  }

  /**
   * Mutate one writable settings layer under the same cross-process lock used
   * by the desktop settings service. Domain tools use this when two related
   * fields must change atomically (for example modelConnections + defaults):
   * composing multiple save*Setting calls would expose an intermediate state
   * and could interleave with another process between writes.
   *
   * The callback receives only the selected layer's raw object, not the merged
   * settings view. The result is schema-validated before it replaces the file.
   * Returning false makes the operation a no-op.
   */
  mutateSettingsForScope(
    scope: "user" | "project",
    cwd: string,
    mutate: (current: Record<string, unknown>) => boolean | void,
  ): void {
    const path =
      scope === "user"
        ? join(this.userConfigDir(), "settings.json")
        : this.projectSettingsPath(cwd);
    if (scope === "project") {
      this.validateProjectCwd(cwd, "project");
      if (!existsSync(cwd)) throw new Error(`project directory does not exist: ${cwd}`);
    }
    this.mutateSettingsFile(path, (current) => {
      if (mutate(current) === false) return false;
      // Validate the complete resulting layer before persistence. We keep the
      // original object for serialization so forward-compatible unknown keys
      // are preserved instead of being stripped by Zod's parsed result.
      validateSettings(current);
      return true;
    });
    this.invalidate();
  }

  /**
   * Delete a single dotted key from the PROJECT-level config file. Used to
   * express "inherit" — we don't persist the literal "inherit"; we remove the
   * override key. No-ops if the file or any intermediate segment is absent.
   */
  deleteProjectSetting(key: string, cwd: string): void {
    const path = this.projectSettingsPath(cwd);
    this.deleteSettingFromFile(path, key);
  }

  /** Delete one dotted key from the machine-private project settings layer. */
  deleteLocalSetting(key: string, cwd: string): void {
    const path = this.localSettingsPath(cwd);
    this.deleteSettingFromFile(path, key);
  }

  /** Delete one dotted key from the user settings layer. */
  deleteUserSetting(key: string): void {
    const path = join(this.userConfigDir(), "settings.json");
    this.deleteSettingFromFile(path, key);
  }

  private deleteSettingFromFile(path: string, key: string): void {
    // Must be YAML-aware, symmetric with saveProjectSetting: a project with only
    // settings.yaml has no .json, so the old `existsSync(path)` guard returned
    // here and the override survived (read/merge ARE yaml-aware → UI shows
    // "inherited" but the key still applies). readJsonObject resolves the sibling
    // YAML; the cleaned object is written back as JSON (JSON is the write-back
    // format and wins over YAML, exactly as save does).
    if (!resolveConfigPath(path)) return;
    this.mutateSettingsFile(path, (current) => {
      const parts = parseDottedSettingKey(key);
      let target: Record<string, unknown> | undefined = current;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i]!;
        // Intermediate segment missing → nothing to delete; skip the write
        // entirely rather than rewriting the file unchanged.
        if (!target || !isOwnPlainObject(target, seg)) return false;
        target = target[seg] as Record<string, unknown>;
      }
      if (target) delete target[parts[parts.length - 1]!];
      return true;
    });
    this.invalidate();
  }

  /**
   * Read ONE scope's raw settings file, validated but UNMERGED. Capability
   * overlay math needs the project overlay and the user/global baseline
   * separately — the merged get() collapses provenance and can't express
   * tri-state inheritance. user → ~/.code-shell/settings.json, project →
   * ${cwd}/.code-shell/settings.json, local →
   * ${cwd}/.code-shell/settings.local.json. Only keys actually present in the
   * file are returned (defaults are not synthesized), so an absent file → {}.
   */
  getForScope(scope: "user" | "project" | "local", cwd?: string): Partial<ValidatedSettings> {
    const path =
      scope === "user"
        ? join(this.userConfigDir(), "settings.json")
        : scope === "local"
          ? this.tryProjectSettingsPath(cwd ?? this.cwd, "settings.local.json")
          : this.tryProjectSettingsPath(cwd ?? this.cwd, "settings.json");
    if (!path) return {};
    const raw = this.readJsonObject(path);
    // validateSettings applies defaults; for a scope view we want only the
    // file's own keys, so validate then project back the present keys.
    const validated = validateSettings(raw) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(raw)) out[k] = validated[k];
    // Same workspace-trust gate as load(): project/local scope reads bypass the
    // merge, so an untrusted project's dangerous fields (for example an MCP
    // server or setup script) must be stripped here too.
    if ((scope === "project" || scope === "local") && !this.projectTrusted) {
      for (const field of DANGEROUS_PROJECT_FIELDS) delete out[field];
    }
    return out as Partial<ValidatedSettings>;
  }

  private projectSettingsPath(cwd: string): string {
    const path = this.tryProjectSettingsPath(cwd, "settings.json", true);
    if (!path) throw new Error("unsafe project settings directory");
    return path;
  }

  private localSettingsPath(cwd: string): string {
    const path = this.tryProjectSettingsPath(cwd, "settings.local.json", true);
    if (!path) throw new Error("unsafe local settings directory");
    return path;
  }

  private validateProjectCwd(cwd: string, layer: "project" | "local"): void {
    if (!cwd || cwd.trim().length === 0) {
      throw new Error(`${layer} setting write requires a non-empty cwd`);
    }
  }

  /** Resolve the project root once and refuse a linked/non-directory state root. */
  private tryProjectSettingsPath(
    cwd: string,
    filename: "settings.json" | "settings.local.json",
    strict = false,
  ): string | null {
    this.validateProjectCwd(cwd, filename === "settings.json" ? "project" : "local");
    if (!existsSync(cwd)) return join(cwd, ".code-shell", filename);
    try {
      const root = realpathSync(cwd);
      if (!lstatSync(root).isDirectory()) throw new Error("project root is not a directory");
      const stateDir = join(root, ".code-shell");
      if (existsSync(stateDir)) {
        const info = lstatSync(stateDir);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new Error("project .code-shell must be a real directory");
        }
      }
      return join(stateDir, filename);
    } catch (error) {
      if (strict) throw error;
      return null;
    }
  }

  private readJsonObject(path: string): Record<string, unknown> {
    // Resolve to a sibling .yaml/.yml when the .json layer is absent so
    // scope views (getForScope) see hand-written YAML too. JSON still wins.
    const resolved = resolveConfigPath(path);
    if (!resolved) return {};
    return parseConfigFile(resolved) ?? {};
  }

  private atomicWriteJson(path: string, data: Record<string, unknown>): void {
    assertSafeSettingsWriteTarget(path);
    const serialized = JSON.stringify(data, null, 2);
    if (Buffer.byteLength(serialized, "utf8") > MAX_SETTINGS_FILE_BYTES) {
      throw new Error(`settings file exceeds ${MAX_SETTINGS_FILE_BYTES} bytes`);
    }
    // mode 0o600: settings.json may hold plaintext API keys — owner-only, see
    // saveUserSetting above and credentials/store.ts.
    writeFileAtomic(path, serialized, 0o600);
  }

  private writeBackup(path: string): void {
    const content = readBoundedRegularFile(path);
    if (content === null) throw new Error("settings backup source is unsafe");
    const backupPath = `${path}.bak`;
    assertSafeSettingsWriteTarget(backupPath);
    writeFileAtomic(backupPath, content, 0o600);
  }

  /**
   * Read-modify-write a settings file under a cross-process lock.
   *
   * Atomic rename alone only prevents a half-written file; it does NOT prevent a
   * lost update. Every writer here used to read its own snapshot outside any
   * lock, so two processes changing DIFFERENT keys still clobbered each other:
   * 48 concurrent writers each setting a distinct key left only 17 keys on disk.
   *
   * Real multi-writer paths, not a theoretical concern: the desktop settings
   * page, the Agent `Config` tool, an automation worker, the TUI and a second
   * desktop instance all write the same files. The desktop settings service
   * already locked correctly; this brings Core's own writers onto the same
   * protocol so they interlock rather than race past one another.
   *
   * `mutate` receives the CURRENT on-disk object (re-read inside the lock) and
   * mutates it in place; returning false skips the write.
   */
  private mutateSettingsFile(
    path: string,
    mutate: (current: Record<string, unknown>) => boolean | void,
  ): void {
    assertSafeSettingsWriteTarget(path);
    const release = acquireFileLock(path);
    try {
      assertSafeSettingsWriteTarget(path);
      // Re-read INSIDE the lock: a snapshot taken before acquiring it would be
      // exactly the stale value that drops the other writer's key.
      const current = this.readJsonObject(path);
      if (mutate(current) === false) return;
      this.atomicWriteJson(path, current);
    } finally {
      release();
    }
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
  try {
    const content = readBoundedRegularFile(path);
    if (content === null) return null;
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

/** Read through a no-follow descriptor so a settings-file symlink cannot escape its layer. */
function readBoundedRegularFile(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_SETTINGS_FILE_BYTES) return null;
    return readFileSync(fd, "utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Writers must never follow a linked settings directory or replace an unusual
 * filesystem object. Atomic rename protects the file contents, but without
 * this boundary check a project-controlled `.code-shell` directory symlink
 * redirects the entire write outside the workspace.
 */
function assertSafeSettingsWriteTarget(path: string): void {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const parentInfo = lstatSync(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new Error("settings directory must be a real directory");
  }
  try {
    const targetInfo = lstatSync(path);
    if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
      throw new Error("settings target must be a regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Given the JSON path for a settings layer (e.g. .../settings.json or
 * .../settings.local.json), return the path that should actually be read:
 * the .json file if it exists, otherwise a sibling .yaml/.yml if present.
 * JSON is the write-back format and wins when both exist; YAML is a
 * hand-written read-only alternative. Returns null when no layer file exists.
 */
function resolveConfigPath(jsonPath: string): string | null {
  const jsonStatus = configCandidateStatus(jsonPath);
  if (jsonStatus === "safe") return jsonPath;
  if (jsonStatus === "unsafe") return null;
  const base = jsonPath.replace(/\.json$/, "");
  for (const ext of [".yaml", ".yml"]) {
    const candidate = `${base}${ext}`;
    const status = configCandidateStatus(candidate);
    if (status === "safe") return candidate;
    if (status === "unsafe") return null;
  }
  return null;
}

function configCandidateStatus(path: string): "missing" | "safe" | "unsafe" {
  try {
    const info = lstatSync(path);
    return !info.isSymbolicLink() && info.isFile() && info.size <= MAX_SETTINGS_FILE_BYTES
      ? "safe"
      : "unsafe";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe";
  }
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

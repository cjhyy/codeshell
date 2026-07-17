/**
 * Install / uninstall plugins from a known marketplace. Mirrors Claude
 * Code's installResolvedPlugin pattern at the MVP subset: four entry
 * source types (path / git / github / git-subdir), no dependencies, no
 * sparse-checkout, no npm/pip.
 */

import { existsSync, realpathSync, rmSync, rmdirSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { gitClone, gitRevParseHead, gitSparseCheckoutAdd, githubRepoToCloneUrl } from "./gitOps.js";
import { loadMarketplace } from "./marketplaceManager.js";
import { readKnownMarketplaces } from "./knownMarketplaces.js";
import {
  appendInstallEntry,
  pluginInstallKey,
  readInstalledPlugins,
  removeInstallEntries,
} from "./installedPlugins.js";
import { rewritePluginVars } from "./varRewrite.js";
import { pluginHookInstallRecord } from "./pluginHookIntegrity.js";
import { pluginMcpInstallRecord } from "./pluginMcpIntegrity.js";
import { assertSafePluginName } from "./installer/paths.js";
import { pruneDisabledSettingsForPlugin } from "./installer/pruneDisabled.js";
import { detectPluginFormat } from "./installer/detectFormat.js";
import { normalizePluginManifest } from "./installer/normalizeManifest.js";
import { normalizePluginMcpMap, readPluginMcp } from "./installer/loadPluginMcp.js";
import { convertCodexAgentsDirectory } from "./installer/codex/convertAgents.js";
import { copyCodexCommands } from "./installer/codex/convertCommands.js";
import { copyCodexHooks } from "./installer/codex/convertHooks.js";
import { resolveCodexMcpServers } from "./installer/codex/convertMcp.js";
import { CodexPluginManifest } from "./installer/types.js";
import {
  resolveContainedPluginSubpath,
  validateRelativePluginSubpath,
} from "./installer/sourcePath.js";
import type { PluginEntrySource, PluginInstallEntry, PluginMarketplaceEntry } from "./types.js";

function userHome(): string {
  return process.env.HOME ?? homedir();
}

function pluginCacheRoot(): string {
  return join(userHome(), ".code-shell", "plugins", "cache");
}

/**
 * Compose the on-disk cache directory for a plugin version. Every path segment
 * (marketplace / plugin / version) can originate from an attacker-controlled
 * marketplace manifest, so each must be validated as a single safe path
 * segment before it enters `join`. Without this a manifest entry named `..`
 * (or containing a separator) would let the materialized plugin tree be
 * written outside the plugin cache root — a supply-chain path traversal.
 *
 * Reuses `assertSafePluginName` (rejects empty / "." / ".." / separators /
 * NUL). Exported so the segment-validation contract can be unit-tested
 * directly.
 */
export function pluginCacheDir(marketplace: string, plugin: string, version: string): string {
  assertSafePluginName(marketplace);
  assertSafePluginName(plugin);
  assertSafePluginName(version);
  return join(pluginCacheRoot(), marketplace, plugin, version);
}

/**
 * Resolve a candidate `installPath` to a realpath and verify it lives strictly
 * underneath the plugin cache root. Returns the resolved path on success, or
 * null when the path is missing, escapes the cache, equals the cache root
 * itself, or is otherwise unsafe to remove.
 *
 * Exported so tests can exercise the safety predicate directly without
 * arranging a full uninstall — the contract this defends (no rmSync outside
 * the plugin cache) is the entire point of T2 / Workstream A2.
 */
export function resolveSafePluginPath(installPath: string, cacheRoot: string): string | null {
  if (typeof installPath !== "string" || installPath.length === 0) return null;

  // Realpath the cache root once. We require it to exist; if the cache root
  // itself can't be resolved, refuse all deletions rather than fall back to
  // a string-only check.
  let safeCacheRoot: string;
  try {
    safeCacheRoot = realpathSync(cacheRoot);
  } catch {
    return null;
  }

  // Realpath the target. A missing target (dangling symlink, already removed,
  // typo in installed_plugins.json) returns null — caller will skip silently.
  let resolvedTarget: string;
  try {
    resolvedTarget = realpathSync(installPath);
  } catch {
    return null;
  }

  // Strict containment: must start with cacheRoot + separator. Equal-to-root
  // is explicitly rejected so a tampered entry can't wipe the whole cache.
  const rootWithSep = safeCacheRoot.endsWith(sep) ? safeCacheRoot : safeCacheRoot + sep;
  if (resolvedTarget === safeCacheRoot) return null;
  if (!resolvedTarget.startsWith(rootWithSep)) return null;

  return resolvedTarget;
}

export interface VarRewriteReport {
  filesScanned: number;
  filesRewritten: number;
}

export type InstallResult =
  | { ok: true; entry: PluginInstallEntry; freshlyCloned: boolean; varRewrite: VarRewriteReport }
  | { ok: false; error: string };

async function projectMarketplacePluginRuntime(
  pluginDir: string,
  pluginName: string,
  format: "cc" | "codex",
): Promise<void> {
  if (format !== "codex") return;
  const manifest = CodexPluginManifest.parse(
    JSON.parse(await readFile(join(pluginDir, ".codex-plugin", "plugin.json"), "utf-8")),
  );
  // Marketplace installs already preserve the complete source package. Add
  // only the CodeShell-native projections that runtime loaders consume.
  await convertCodexAgentsDirectory(pluginDir, pluginDir, pluginName);
  await copyCodexCommands(pluginDir, pluginDir);
  await copyCodexHooks(pluginDir, pluginDir, manifest.hooks);

  const servers = resolveCodexMcpServers(pluginDir, manifest.mcpServers);
  const keyed: Record<string, unknown> = {};
  for (const [serverName, config] of Object.entries(servers)) {
    const key = `${pluginName}:${serverName}`;
    keyed[key] = { ...(config as object), name: key };
  }
  if (Object.keys(keyed).length > 0) {
    const normalized = normalizePluginMcpMap(keyed, pluginName, true);
    if (Object.keys(normalized).length !== Object.keys(keyed).length) {
      throw new Error("invalid plugin MCP server declaration");
    }
    await writeFile(
      join(pluginDir, "mcp-servers.json"),
      JSON.stringify(normalized, null, 2),
      "utf-8",
    );
  }
}

async function materializePath(
  marketplaceInstallLocation: string,
  relativePath: string,
  cacheTarget: string,
): Promise<{ ok: true; sha: string | undefined } | { ok: false; error: string }> {
  const contained = resolveContainedPluginSubpath(
    marketplaceInstallLocation,
    relativePath,
    "plugin source path",
  );
  if (!contained.ok) {
    return { ok: false, error: contained.error };
  }
  const src = contained.path;
  await mkdir(dirname(cacheTarget), { recursive: true });
  if (existsSync(cacheTarget)) await rm(cacheTarget, { recursive: true, force: true });
  await cp(src, cacheTarget, { recursive: true });
  return { ok: true, sha: undefined };
}

async function materializeGit(
  url: string,
  ref: string | undefined,
  cacheTarget: string,
): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  await mkdir(dirname(cacheTarget), { recursive: true });
  if (existsSync(cacheTarget)) await rm(cacheTarget, { recursive: true, force: true });
  const clone = await gitClone(url, cacheTarget, { full: true, ...(ref ? { ref } : {}) });
  if (!clone.ok) return { ok: false, error: clone.error };
  const head = await gitRevParseHead(cacheTarget);
  if (!head.ok) return { ok: false, error: head.error };
  return { ok: true, sha: head.stdout };
}

async function materializeGitSubdir(
  url: string,
  subPath: string,
  ref: string | undefined,
  cacheTarget: string,
): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  const invalid = validateRelativePluginSubpath(subPath, "git-subdir path");
  if (invalid) return { ok: false, error: invalid };

  // Clone to a tempdir, then copy the subdir over.
  const tmp = await mkdtemp(join(tmpdir(), "plugin-clone-"));
  try {
    const repoDir = join(tmp, "repo");
    const clone = await gitClone(url, repoDir, { full: true, ...(ref ? { ref } : {}) });
    if (!clone.ok) return { ok: false, error: clone.error };
    const head = await gitRevParseHead(repoDir);
    if (!head.ok) return { ok: false, error: head.error };
    const contained = resolveContainedPluginSubpath(repoDir, subPath, "git-subdir path");
    if (!contained.ok) return { ok: false, error: contained.error };
    const src = contained.path;
    await mkdir(dirname(cacheTarget), { recursive: true });
    if (existsSync(cacheTarget)) await rm(cacheTarget, { recursive: true, force: true });
    await cp(src, cacheTarget, { recursive: true });
    return { ok: true, sha: head.stdout };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

function shortSha(sha: string | undefined): string {
  if (!sha) return "unknown";
  return sha.slice(0, 12);
}

/**
 * Compare a marketplace-declared SHA against the cloned HEAD. The
 * declaration is allowed to be a short prefix (>= 7 chars, standard git
 * abbreviation length); for stricter integrity guarantees marketplaces
 * should pin the full 40-char hash. Case-insensitive.
 *
 * Exported so a unit test can pin the policy without spinning up a real
 * clone.
 */
export function shaMatches(declared: string, actual: string): boolean {
  if (typeof declared !== "string" || typeof actual !== "string") return false;
  const d = declared.trim().toLowerCase();
  const a = actual.trim().toLowerCase();
  if (d.length < 7) return false; // refuse 6-or-less; too collision-prone
  if (d.length > 40) return false; // not a valid SHA
  return a.startsWith(d);
}

async function materialize(
  source: PluginEntrySource,
  marketplaceInstallLocation: string,
  marketplace: string,
  plugin: string,
): Promise<
  | { ok: true; cacheDir: string; version: string; sha: string | undefined }
  | { ok: false; error: string }
> {
  // First pass: install into a placeholder dir, then rename to the SHA dir
  // once we know it. For path sources there's no SHA — use "local".
  const placeholder = pluginCacheDir(marketplace, plugin, "_pending_");

  if (typeof source === "string") {
    const invalid = validateRelativePluginSubpath(source, "plugin source path");
    if (invalid) return { ok: false, error: invalid };
    // The marketplace was cloned sparse (only the manifest dirs are on disk),
    // so a local-path plugin's tree may not be checked out yet. Expand the
    // sparse-checkout to include it before reading. Best-effort: on a
    // non-sparse (full) clone this errors harmlessly and the files are already
    // present, so we ignore the result and let materializePath report a real
    // missing-path error if the subdir truly isn't there.
    // Strip a leading "./" — in non-cone sparse mode the literal "./" prefix
    // doesn't match repo paths (which are stored without it), so the
    // expand would silently no-op and the tree would stay un-materialized.
    const sparseRel = source.replace(/^\.\//, "");
    await gitSparseCheckoutAdd(marketplaceInstallLocation, sparseRel);
    const r = await materializePath(marketplaceInstallLocation, source, placeholder);
    if (!r.ok) return r;
    const finalDir = pluginCacheDir(marketplace, plugin, "local");
    if (existsSync(finalDir)) await rm(finalDir, { recursive: true, force: true });
    await mkdir(dirname(finalDir), { recursive: true });
    await cp(placeholder, finalDir, { recursive: true });
    await rm(placeholder, { recursive: true, force: true });
    return { ok: true, cacheDir: finalDir, version: "local", sha: undefined };
  }

  if (source.source === "git" || source.source === "github") {
    const url = source.source === "github" ? githubRepoToCloneUrl(source.repo) : source.url;
    const r = await materializeGit(url, source.ref, placeholder);
    if (!r.ok) {
      if (existsSync(placeholder)) await rm(placeholder, { recursive: true, force: true });
      return r;
    }
    // Supply-chain check: when the marketplace entry pins a SHA, fail the
    // install if the cloned HEAD doesn't match. Without this the `sha`
    // field is decorative — present in metadata, never enforced.
    if (source.sha && !shaMatches(source.sha, r.sha)) {
      if (existsSync(placeholder)) await rm(placeholder, { recursive: true, force: true });
      return {
        ok: false,
        error: `sha mismatch for ${plugin}: expected ${source.sha}, got ${r.sha}`,
      };
    }
    const version = shortSha(r.sha);
    const finalDir = pluginCacheDir(marketplace, plugin, version);
    if (existsSync(finalDir)) await rm(finalDir, { recursive: true, force: true });
    await mkdir(dirname(finalDir), { recursive: true });
    await cp(placeholder, finalDir, { recursive: true });
    await rm(placeholder, { recursive: true, force: true });
    return { ok: true, cacheDir: finalDir, version, sha: r.sha };
  }

  if (source.source === "git-subdir") {
    const r = await materializeGitSubdir(source.url, source.path, source.ref, placeholder);
    if (!r.ok) {
      if (existsSync(placeholder)) await rm(placeholder, { recursive: true, force: true });
      return r;
    }
    if (source.sha && !shaMatches(source.sha, r.sha)) {
      if (existsSync(placeholder)) await rm(placeholder, { recursive: true, force: true });
      return {
        ok: false,
        error: `sha mismatch for ${plugin}: expected ${source.sha}, got ${r.sha}`,
      };
    }
    const version = shortSha(r.sha);
    const finalDir = pluginCacheDir(marketplace, plugin, version);
    if (existsSync(finalDir)) await rm(finalDir, { recursive: true, force: true });
    await mkdir(dirname(finalDir), { recursive: true });
    await cp(placeholder, finalDir, { recursive: true });
    await rm(placeholder, { recursive: true, force: true });
    return { ok: true, cacheDir: finalDir, version, sha: r.sha };
  }

  return {
    ok: false,
    error: `unsupported source type "${(source as { source?: string }).source}"`,
  };
}

/**
 * Install a plugin from a previously-added marketplace into the user
 * cache. Idempotent within a process: re-installing replaces the
 * cached files and updates the manifest entry.
 */
export async function installPlugin(
  pluginName: string,
  marketplaceName: string,
): Promise<InstallResult> {
  const key = pluginInstallKey(pluginName, marketplaceName);
  const previousEntries = readInstalledPlugins().plugins[key] ?? [];
  const known = readKnownMarketplaces();
  const km = known[marketplaceName];
  if (!km) {
    return {
      ok: false,
      error: `marketplace "${marketplaceName}" not found. Run /plugin marketplace add first.`,
    };
  }
  const manifest = loadMarketplace(marketplaceName);
  if (!manifest) {
    return {
      ok: false,
      error: `marketplace "${marketplaceName}" is registered but its manifest could not be loaded.`,
    };
  }
  const entry: PluginMarketplaceEntry | undefined = manifest.plugins.find(
    (p) => p.name === pluginName,
  );
  if (!entry) {
    return {
      ok: false,
      error: `plugin "${pluginName}" not found in marketplace "${marketplaceName}".`,
    };
  }

  // materialize() validates every cache path segment (marketplace / plugin /
  // version) and throws a PluginInstallError on an unsafe one. Convert that to
  // a clean failure result — every caller (bootstrap / marketplace-service /
  // tui handler) consumes { ok, error } and must not be crashed by a hostile
  // marketplace manifest.
  let mat: Awaited<ReturnType<typeof materialize>>;
  try {
    mat = await materialize(entry.source, km.installLocation, marketplaceName, pluginName);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (!mat.ok) return mat;

  // Project Codex package components into the same runtime-native layout used
  // by local/direct installs, then validate and freeze the author manifest
  // before the install becomes visible in installed_plugins.json.
  try {
    const format = detectPluginFormat(mat.cacheDir);
    await projectMarketplacePluginRuntime(mat.cacheDir, pluginName, format);
    await normalizePluginManifest(mat.cacheDir, {
      name: pluginName,
      version: entry.version ?? mat.version,
      format,
      destinationRoot: mat.cacheDir,
    });
  } catch (error) {
    await rm(mat.cacheDir, { recursive: true, force: true });
    return {
      ok: false,
      error: `invalid plugin manifest: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Rewrite Claude-specific plugin root/data variables across every text file
  // in the materialized tree. The runtime exposes CodeShell-native names plus
  // Codex aliases, while keeping Claude host-detection variables unset. The
  // breadcrumb documents the rewrite for users debugging upstream diffs.
  const rewriteSummary = rewritePluginVars(mat.cacheDir);

  // Remove old install entries for the same key so we don't pile up
  // historical versions (Phase A: single-scope only).
  removeInstallEntries(key);

  const now = new Date().toISOString();
  const installEntry: PluginInstallEntry = {
    scope: "user",
    installPath: mat.cacheDir,
    version: mat.version,
    installedAt: now,
    lastUpdated: now,
    ...(mat.sha ? { gitCommitSha: mat.sha } : {}),
    ...pluginHookInstallRecord(mat.cacheDir, previousEntries),
    ...pluginMcpInstallRecord(
      mat.cacheDir,
      Object.keys(readPluginMcp(mat.cacheDir, pluginName)).length > 0,
      previousEntries,
    ),
  };
  appendInstallEntry(key, installEntry);

  return {
    ok: true,
    entry: installEntry,
    freshlyCloned: true,
    varRewrite: {
      filesScanned: rewriteSummary.filesScanned,
      filesRewritten: rewriteSummary.filesRewritten,
    },
  };
}

export interface UninstallResult {
  ok: boolean;
  removedFromManifest: boolean;
  removedFromDisk: boolean;
}

export function uninstallPlugin(pluginName: string, marketplaceName: string): UninstallResult {
  const key = pluginInstallKey(pluginName, marketplaceName);
  const data = readInstalledPlugins();
  const entries = data.plugins[key];
  let removedFromDisk = false;
  const cacheRoot = pluginCacheRoot();
  if (entries) {
    for (const e of entries) {
      if (!e.installPath) continue;
      // Containment check: the on-disk installed_plugins.json can be tampered
      // with to point at arbitrary paths (e.g. "/", "$HOME"). Refuse to rm
      // anything that doesn't realpath to a strict child of the plugin cache.
      const safePath = resolveSafePluginPath(e.installPath, cacheRoot);
      if (!safePath) continue;
      if (existsSync(safePath)) {
        rmSync(safePath, { recursive: true, force: true });
        removedFromDisk = true;
      }
    }
    // Also clean up the per-plugin parent if empty.
    const pluginParent = join(pluginCacheRoot(), marketplaceName, pluginName);
    try {
      // rmdir succeeds only when empty; ignore failures.
      rmdirSync(pluginParent);
    } catch {
      // not empty or doesn't exist — fine
    }
  }
  const removedFromManifest = removeInstallEntries(key);
  // Clear orphaned disable flags (disabledSkills "name:skill" /
  // disabledPlugins "name") so a removed plugin leaves no dangling entries.
  pruneDisabledSettingsForPlugin(pluginName);
  return { ok: removedFromManifest || removedFromDisk, removedFromManifest, removedFromDisk };
}

export function listInstalled(): { key: string; entry: PluginInstallEntry }[] {
  const data = readInstalledPlugins();
  const out: { key: string; entry: PluginInstallEntry }[] = [];
  for (const [key, entries] of Object.entries(data.plugins)) {
    for (const e of entries) {
      out.push({ key, entry: e });
    }
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

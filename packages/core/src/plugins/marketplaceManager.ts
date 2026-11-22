/**
 * Marketplace lifecycle: add (clone + validate + persist), remove
 * (delete from disk + manifest), list, load (read marketplace.json on
 * demand). Mirrors Claude Code's utils/plugins/marketplaceManager.ts
 * at the MVP subset (github + git sources only, no auto-update,
 * no policy blocking, no GCS mirror).
 */

import { existsSync, readFileSync, rmSync, mkdirSync, renameSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { marketplaceLifetime, gitClone, githubRepoToCloneUrl } from "./gitOps.js";
import {
  readKnownMarketplaces,
  upsertKnownMarketplace,
  removeKnownMarketplace,
} from "./knownMarketplaces.js";
import { acquireLockOnPath } from "../utils/file-mutex.js";
import { validateMarketplace } from "./schemas.js";
import { assertSafePluginName } from "./installer/paths.js";
import type {
  KnownMarketplace,
  MarketplaceFormat,
  MarketplaceSource,
  PluginMarketplace,
} from "./types.js";

export type { MarketplaceFormat } from "./types.js";

export function createMarketplaceLifetime(signal: AbortSignal, isClosing: () => boolean) {
  let cleanupError: string | undefined;
  const owner = {
    signal,
    isClosing,
    recordCleanupFailure(error: string) {
      cleanupError ??= error;
    },
  };
  return {
    run<T>(work: () => T): T {
      return marketplaceLifetime.run(owner, work);
    },
    get cleanupError() {
      return cleanupError;
    },
  };
}

/** A worker blocked on a contended synchronous lock can still see its owner's closing flag. */
function assertMarketplaceOpen(): void {
  if (marketplaceLifetime.getStore()?.isClosing()) throw Error("Marketplace is closing");
}

function userHome(): string {
  return process.env.HOME ?? homedir();
}

export function marketplacesRoot(): string {
  return join(userHome(), ".code-shell", "plugins", "marketplaces");
}

export function marketplaceDir(name: string): string {
  // Single choke point for add/remove/refresh (all derive `dir` from here and
  // then gitClone / rmSync it). Validate `name` as one safe path segment so a
  // `..` / separator / NUL can't escape marketplacesRoot. Normal derived names
  // (lowercase repo tails) are unaffected; reuses the plugin segment guard.
  assertSafePluginName(name);
  return join(marketplacesRoot(), name);
}

const CC_MANIFEST_REL = [".claude-plugin", "marketplace.json"] as const;
const CODEX_MANIFEST_REL = [".agents", "plugins", "marketplace.json"] as const;

/**
 * Resolve the marketplace manifest inside a cloned repo. Claude Code's format
 * lives at .claude-plugin/marketplace.json; the Codex / agents format lives at
 * .agents/plugins/marketplace.json. Prefer the CC manifest when present (it is
 * our canonical shape), else fall back to the Codex one. Returns null when
 * neither exists.
 */
function resolveManifestPath(dir: string): string | null {
  const cc = join(dir, ...CC_MANIFEST_REL);
  if (existsSync(cc)) return cc;
  const codex = join(dir, ...CODEX_MANIFEST_REL);
  if (existsSync(codex)) return codex;
  return null;
}

function marketplaceJsonPath(name: string): string | null {
  return resolveManifestPath(marketplaceDir(name));
}

/**
 * Classify a cloned marketplace by which manifest files it ships:
 * both → universal, only .agents/plugins → codex, otherwise claude-code.
 */
export function detectMarketplaceFormat(dir: string): MarketplaceFormat {
  const hasCc = existsSync(join(dir, ...CC_MANIFEST_REL));
  const hasCodex = existsSync(join(dir, ...CODEX_MANIFEST_REL));
  if (hasCc && hasCodex) return "universal";
  if (hasCodex) return "codex";
  return "claude-code";
}

function sourceToCloneUrl(source: MarketplaceSource): string {
  return source.source === "github" ? githubRepoToCloneUrl(source.repo) : source.url;
}

export type AddMarketplaceResult =
  | { ok: true; name: string; marketplace: PluginMarketplace; replaced: boolean }
  | { ok: false; error: string };

/** Validate before publishing. The previous checkout remains usable during a slow clone. */
function checkedManifest(name: string, dir: string) {
  const path = resolveManifestPath(dir);
  if (!path)
    return {
      ok: false as const,
      error: `Marketplace ${name}: no marketplace.json found (looked in .claude-plugin/ and .agents/plugins/).`,
    };
  try {
    const result = validateMarketplace(JSON.parse(readFileSync(path, "utf8")));
    return result.ok
      ? result
      : { ok: false as const, error: `Marketplace ${name}: ${result.error}` };
  } catch (error) {
    return {
      ok: false as const,
      error: `Marketplace ${name}: failed to parse marketplace.json: ${(error as Error).message}`,
    };
  }
}
export async function addMarketplace(
  name: string,
  source: MarketplaceSource,
  beforeCommit?: () => void,
): Promise<AddMarketplaceResult> {
  const dir = marketplaceDir(name);
  const previous = readKnownMarketplaces()[name];
  mkdirSync(marketplacesRoot(), { recursive: true });
  const staging = mkdtempSync(join(marketplacesRoot(), ".publish-"));
  const checkout = join(staging, "next"),
    backup = join(staging, "old");
  let committed = false;
  try {
    const cloned = await gitClone(sourceToCloneUrl(source), checkout);
    // Offline refresh of the same origin historically retains the last usable checkout.
    if (
      !cloned.ok &&
      (!previous || JSON.stringify(previous.source) !== JSON.stringify(source) || !existsSync(dir))
    )
      return { ok: false, error: cloned.error };
    const candidate = cloned.ok ? checkout : dir;
    const manifest = checkedManifest(name, candidate);
    if (!manifest.ok) return manifest;
    const entry: KnownMarketplace = {
      source,
      installLocation: dir,
      lastUpdated: new Date().toISOString(),
      format: detectMarketplaceFormat(candidate),
    };
    const release = acquireLockOnPath(marketplacesRoot(), undefined, assertMarketplaceOpen);
    try {
      if (JSON.stringify(readKnownMarketplaces()[name]) !== JSON.stringify(previous))
        return { ok: false, error: `Marketplace ${name} changed while refreshing; try again` };
      assertMarketplaceOpen();
      beforeCommit?.();
      const replace = cloned.ok && existsSync(dir);
      if (replace) renameSync(dir, backup);
      let published = false;
      try {
        if (cloned.ok) {
          renameSync(checkout, dir);
          published = true;
        }
        upsertKnownMarketplace(name, entry);
        committed = true;
      } catch (error) {
        if (published) renameSync(dir, checkout);
        if (replace) renameSync(backup, dir);
        throw error;
      }
    } finally {
      release();
    }
    return { ok: true, name, marketplace: manifest.value, replaced: !!previous };
  } finally {
    // Keep an intact last-known checkout if a filesystem fault prevented rollback.
    if (committed || !existsSync(backup)) rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Refreshes a known marketplace: re-pulls its source so the cached
 * marketplace.json reflects upstream (new plugins, version bumps). Reuses
 * addMarketplace's same-source path (git fetch + reset). Returns an error if
 * the marketplace isn't known.
 */
export async function refreshMarketplace(
  name: string,
  beforeCommit?: () => void,
): Promise<AddMarketplaceResult> {
  const known = readKnownMarketplaces();
  const entry = known[name];
  if (!entry) {
    return { ok: false, error: `Unknown marketplace: ${name}` };
  }
  return addMarketplace(name, entry.source, beforeCommit);
}

/**
 * Removes a marketplace: deletes the cached clone and the manifest entry.
 * Returns whether anything was actually removed.
 */
export function removeMarketplace(name: string, beforeCommit?: () => void): boolean {
  const dir = marketplaceDir(name);
  mkdirSync(marketplacesRoot(), { recursive: true });
  const release = acquireLockOnPath(marketplacesRoot(), undefined, assertMarketplaceOpen);
  try {
    assertMarketplaceOpen();
    beforeCommit?.();
    const removed = removeKnownMarketplace(name);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    return removed;
  } finally {
    release();
  }
}

/**
 * Loads a previously-added marketplace's manifest from disk. Returns null
 * if the marketplace is unknown or the manifest is gone (caller can
 * report to user).
 */
export function loadMarketplace(name: string): PluginMarketplace | null {
  const known = readKnownMarketplaces();
  if (!known[name]) return null;
  const manifestPath = marketplaceJsonPath(name);
  if (!manifestPath) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return null;
  }
  const v = validateMarketplace(raw);
  return v.ok ? v.value : null;
}

export interface ListedMarketplace {
  name: string;
  source: MarketplaceSource;
  installLocation: string;
  lastUpdated: string;
  pluginCount: number;
  format: MarketplaceFormat;
}

/**
 * Lists all known marketplaces with a quick plugin count read from each
 * cached manifest. Marketplaces whose manifest is missing or invalid
 * show pluginCount: -1 so the caller can flag them.
 */
export function listMarketplaces(): ListedMarketplace[] {
  const known = readKnownMarketplaces();
  const out: ListedMarketplace[] = [];
  for (const [name, entry] of Object.entries(known)) {
    const mp = loadMarketplace(name);
    out.push({
      name,
      source: entry.source,
      installLocation: entry.installLocation,
      lastUpdated: entry.lastUpdated,
      pluginCount: mp ? mp.plugins.length : -1,
      // Re-detect from disk when the stored entry predates the format field.
      format: entry.format ?? detectMarketplaceFormat(entry.installLocation),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

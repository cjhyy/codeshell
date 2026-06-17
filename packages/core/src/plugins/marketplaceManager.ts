/**
 * Marketplace lifecycle: add (clone + validate + persist), remove
 * (delete from disk + manifest), list, load (read marketplace.json on
 * demand). Mirrors Claude Code's utils/plugins/marketplaceManager.ts
 * at the MVP subset (github + git sources only, no auto-update,
 * no policy blocking, no GCS mirror).
 */

import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { gitClone, gitFetchAndReset, githubRepoToCloneUrl } from "./gitOps.js";
import {
  readKnownMarketplaces,
  upsertKnownMarketplace,
  removeKnownMarketplace,
} from "./knownMarketplaces.js";
import { validateMarketplace } from "./schemas.js";
import type {
  KnownMarketplace,
  MarketplaceFormat,
  MarketplaceSource,
  PluginMarketplace,
} from "./types.js";

export type { MarketplaceFormat } from "./types.js";

function userHome(): string {
  return process.env.HOME ?? homedir();
}

export function marketplacesRoot(): string {
  return join(userHome(), ".code-shell", "plugins", "marketplaces");
}

export function marketplaceDir(name: string): string {
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

/**
 * Adds a marketplace by cloning it (or refreshing if already present
 * with the same source), validating its marketplace.json, and writing
 * an entry into known_marketplaces.json.
 */
export async function addMarketplace(
  name: string,
  source: MarketplaceSource,
): Promise<AddMarketplaceResult> {
  const dir = marketplaceDir(name);
  const known = readKnownMarketplaces();
  const existing = known[name];

  const sameSource =
    existing &&
    JSON.stringify(existing.source) === JSON.stringify(source) &&
    existsSync(dir);

  if (sameSource) {
    // Refresh: pull latest. Best-effort; if fetch fails we still try to
    // validate the existing checkout.
    const ref = source.source === "git" ? undefined : undefined; // MVP: default branch
    await gitFetchAndReset(dir, ref);
  } else {
    // Fresh clone (delete first if a stale directory exists).
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(marketplacesRoot(), { recursive: true });
    const clone = await gitClone(sourceToCloneUrl(source), dir);
    if (!clone.ok) {
      return { ok: false, error: clone.error };
    }
  }

  const manifestPath = marketplaceJsonPath(name);
  if (!manifestPath) {
    rmSync(dir, { recursive: true, force: true });
    return {
      ok: false,
      error: `Marketplace ${name}: no marketplace.json found (looked in .claude-plugin/ and .agents/plugins/).`,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    return {
      ok: false,
      error: `Marketplace ${name}: failed to parse marketplace.json: ${(e as Error).message}`,
    };
  }

  const v = validateMarketplace(raw);
  if (!v.ok) {
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, error: `Marketplace ${name}: ${v.error}` };
  }

  const entry: KnownMarketplace = {
    source,
    installLocation: dir,
    lastUpdated: new Date().toISOString(),
    format: detectMarketplaceFormat(dir),
  };
  upsertKnownMarketplace(name, entry);

  return { ok: true, name, marketplace: v.value, replaced: Boolean(existing) };
}

/**
 * Refreshes a known marketplace: re-pulls its source so the cached
 * marketplace.json reflects upstream (new plugins, version bumps). Reuses
 * addMarketplace's same-source path (git fetch + reset). Returns an error if
 * the marketplace isn't known.
 */
export async function refreshMarketplace(name: string): Promise<AddMarketplaceResult> {
  const known = readKnownMarketplaces();
  const entry = known[name];
  if (!entry) {
    return { ok: false, error: `Unknown marketplace: ${name}` };
  }
  return addMarketplace(name, entry.source);
}

/**
 * Removes a marketplace: deletes the cached clone and the manifest entry.
 * Returns whether anything was actually removed.
 */
export function removeMarketplace(name: string): boolean {
  const removed = removeKnownMarketplace(name);
  const dir = marketplaceDir(name);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
  return removed;
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

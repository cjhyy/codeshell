/** Read/write ~/.code-shell/plugins/known_marketplaces.json. */

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { KnownMarketplaces, KnownMarketplace } from "./types.js";
import { mutateJsonFile } from "../utils/file-mutex.js";

const MAX_MARKETPLACE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_MARKETPLACES = 256;
const MAX_NAME_LENGTH = 128;
const MAX_PATH_LENGTH = 4_096;
const MAX_TIMESTAMP_LENGTH = 128;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const GITHUB_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * The single source of truth for what a marketplace name may be.
 *
 * Exported so entry points (AddMarketplace) reject a bad name BEFORE cloning,
 * rather than discovering it at persist time and orphaning the clone.
 */
export function isValidMarketplaceName(name: string): boolean {
  return name.length <= MAX_NAME_LENGTH && NAME_RE.test(name);
}

function userHome(): string {
  return process.env.HOME ?? homedir();
}

export function knownMarketplacesPath(): string {
  return join(userHome(), ".code-shell", "plugins", "known_marketplaces.json");
}

function marketplaceOf(value: unknown): KnownMarketplace | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!raw.source || typeof raw.source !== "object" || Array.isArray(raw.source)) return undefined;
  const source = raw.source as Record<string, unknown>;
  const normalizedSource =
    source.source === "github" &&
    typeof source.repo === "string" &&
    GITHUB_REPO_RE.test(source.repo)
      ? ({ source: "github", repo: source.repo } as const)
      : source.source === "git" &&
          typeof source.url === "string" &&
          source.url.length > 0 &&
          source.url.length <= MAX_PATH_LENGTH &&
          !source.url.includes("\0")
        ? ({ source: "git", url: source.url } as const)
        : undefined;
  if (
    !normalizedSource ||
    typeof raw.installLocation !== "string" ||
    raw.installLocation.length === 0 ||
    raw.installLocation.length > MAX_PATH_LENGTH ||
    raw.installLocation.includes("\0") ||
    typeof raw.lastUpdated !== "string" ||
    raw.lastUpdated.length === 0 ||
    raw.lastUpdated.length > MAX_TIMESTAMP_LENGTH
  ) {
    return undefined;
  }
  const format =
    raw.format === "claude-code" || raw.format === "codex" || raw.format === "universal"
      ? raw.format
      : undefined;
  if (raw.format !== undefined && !format) return undefined;
  return {
    source: normalizedSource,
    installLocation: raw.installLocation,
    lastUpdated: raw.lastUpdated,
    ...(format ? { format } : {}),
  };
}

function parseKnownMarketplaces(raw: string | undefined): KnownMarketplaces {
  if (raw === undefined) return Object.create(null) as KnownMarketplaces;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("known marketplaces registry must be an object");
  }
  const entries = Object.entries(parsed);
  if (entries.length > MAX_MARKETPLACES) throw new Error("too many known marketplaces");
  const result = Object.create(null) as KnownMarketplaces;
  for (const [name, value] of entries) {
    // ISOLATE, don't throw. NAME_RE is stricter than the writers that produced
    // these keys (AddMarketplace accepts any non-empty string, and
    // assertSafePluginName permits spaces/non-ASCII), so a single legacy name
    // like "My Market" used to make the whole registry read as empty AND make
    // every subsequent write throw — unrecoverable, because the read reported
    // nothing for the user to fix. Skipping matches registryOf() in
    // installedPlugins.ts, which is the correct shape for this file family.
    if (name.length > MAX_NAME_LENGTH || !NAME_RE.test(name)) continue;
    const marketplace = marketplaceOf(value);
    if (!marketplace) continue;
    result[name] = marketplace;
  }
  return result;
}

export function readKnownMarketplaces(): KnownMarketplaces {
  const path = knownMarketplacesPath();
  let descriptor: number | undefined;
  try {
    const metadata = lstatSync(path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size > MAX_MARKETPLACE_FILE_BYTES
    ) {
      return Object.create(null) as KnownMarketplaces;
    }
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > MAX_MARKETPLACE_FILE_BYTES) {
      return Object.create(null) as KnownMarketplaces;
    }
    return parseKnownMarketplaces(readFileSync(descriptor, "utf8"));
  } catch {
    return Object.create(null) as KnownMarketplaces;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function mutateKnownMarketplaces(
  change: (current: KnownMarketplaces) => { value?: KnownMarketplaces; result?: boolean },
): boolean | undefined {
  return mutateJsonFile<KnownMarketplaces, boolean>(knownMarketplacesPath(), {
    parse: parseKnownMarketplaces,
    serialize: (value) => `${JSON.stringify(value, null, 2)}\n`,
    mutation: change,
    mode: 0o600,
    maxBytes: MAX_MARKETPLACE_FILE_BYTES,
  });
}

export function writeKnownMarketplaces(data: KnownMarketplaces): void {
  const validated = parseKnownMarketplaces(JSON.stringify(data));
  mutateKnownMarketplaces(() => ({ value: validated }));
}

export function upsertKnownMarketplace(name: string, entry: KnownMarketplace): void {
  const marketplace = marketplaceOf(entry);
  if (!NAME_RE.test(name) || !marketplace) throw new Error("invalid known marketplace");
  mutateKnownMarketplaces((current) => ({ value: { ...current, [name]: marketplace } }));
}

export function removeKnownMarketplace(name: string): boolean {
  if (!NAME_RE.test(name)) return false;
  return (
    mutateKnownMarketplaces((current) => {
      if (!Object.prototype.hasOwnProperty.call(current, name)) return { result: false };
      const next = { ...current };
      delete next[name];
      return { value: next, result: true };
    }) ?? false
  );
}

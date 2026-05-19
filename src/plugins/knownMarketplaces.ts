/**
 * Read/write ~/.code-shell/plugins/known_marketplaces.json.
 * File format is byte-compatible with Claude Code's analogous file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { KnownMarketplaces, KnownMarketplace } from "./types.js";

function userHome(): string {
  return process.env.HOME ?? homedir();
}

export function knownMarketplacesPath(): string {
  return join(userHome(), ".code-shell", "plugins", "known_marketplaces.json");
}

export function readKnownMarketplaces(): KnownMarketplaces {
  const path = knownMarketplacesPath();
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as KnownMarketplaces;
    }
  } catch {
    // Corrupted file: treat as empty so the caller can recover by re-adding.
  }
  return {};
}

export function writeKnownMarketplaces(data: KnownMarketplaces): void {
  const path = knownMarketplacesPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function upsertKnownMarketplace(name: string, entry: KnownMarketplace): void {
  const data = readKnownMarketplaces();
  data[name] = entry;
  writeKnownMarketplaces(data);
}

export function removeKnownMarketplace(name: string): boolean {
  const data = readKnownMarketplaces();
  if (!(name in data)) return false;
  delete data[name];
  writeKnownMarketplaces(data);
  return true;
}

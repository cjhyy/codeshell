/**
 * Plugin marketplace type definitions for codeshell. Schemas mirror Claude
 * Code's plugin system (see claude-code-sourcemap/restored-src/src/utils/plugins/schemas.ts)
 * at the MVP subset documented in
 * docs/superpowers/specs/2026-05-19-plugin-marketplace-design.md.
 */

export type MarketplaceSource =
  | { source: "github"; repo: string /* owner/name */ }
  | { source: "git"; url: string };

/** Which plugin-manifest convention a cloned marketplace ships. */
export type MarketplaceFormat = "claude-code" | "codex" | "universal";

export interface KnownMarketplace {
  source: MarketplaceSource;
  installLocation: string;
  lastUpdated: string;
  /** Optional: absent on entries written before format detection existed. */
  format?: MarketplaceFormat;
}

export type KnownMarketplaces = Record<string, KnownMarketplace>;

export type PluginEntrySource =
  | string
  | { source: "git"; url: string; ref?: string; sha?: string }
  | { source: "github"; repo: string; ref?: string; sha?: string }
  | { source: "git-subdir"; url: string; path: string; ref?: string; sha?: string };

export interface PluginMarketplaceEntry {
  name: string;
  description?: string;
  author?: { name: string; email?: string };
  category?: string;
  source: PluginEntrySource;
  homepage?: string;
  /**
   * Declared version from the marketplace manifest, when the author wrote
   * one. CC's marketplace.json has no version convention, so this is often
   * absent — the UI hides it rather than showing a placeholder.
   */
  version?: string;
}

export interface PluginMarketplace {
  name: string;
  description?: string;
  owner: { name: string; email?: string };
  plugins: PluginMarketplaceEntry[];
}

export interface PluginInstallEntry {
  scope: "user";
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  gitCommitSha?: string;
}

export interface InstalledPluginsV2 {
  version: 2;
  plugins: Record<string, PluginInstallEntry[]>;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

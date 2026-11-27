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
  /** CodeShell extension: digest of hooks/hooks.json captured at install/update. */
  hookDigest?: string;
  /**
   * CodeShell extension: the hook digest the user explicitly approved.
   * Missing means executable hooks are pending approval. Hook-free installs
   * auto-approve their absent-hooks digest so they never show a prompt.
   */
  approvedHookDigest?: string;
  /**
   * Bounded display snapshot of the last explicitly approved hook definition.
   * It is non-executable review metadata used to show per-command update diffs.
   */
  approvedHookSnapshot?: StoredPluginHookReview[];
  /** CodeShell extension: digest of the effective plugin MCP declaration. */
  mcpDigest?: string;
  /**
   * CodeShell extension: the MCP digest the user explicitly approved.
   * Missing means plugin-provided external processes / remote connections are
   * pending approval. Installs without any valid MCP servers auto-approve.
   */
  approvedMcpDigest?: string;
  /**
   * CodeShell extension: digest of the whole install tree captured at
   * install/update (see pluginTreeDigest). Missing on installs that predate
   * whole-tree approval; their executable content is pending until approved.
   */
  contentDigest?: string;
  /**
   * CodeShell extension: the installed version the user agreed to run.
   * Command hooks, MCP servers and the native entry all require it to equal
   * `contentDigest`, in addition to their own approval. It is compared with
   * the record, never with the files on disk: local edits after approval run
   * as they are.
   */
  approvedContentDigest?: string;
  /**
   * CodeShell extension: the tree digest for which the user agreed to run the
   * plugin's native entry (plugins/native). Separate from the hook and MCP
   * approvals so approving one kind never starts another.
   */
  approvedNativeDigest?: string;
  /**
   * What the native manifest declared when it was last approved. Display
   * metadata only: it is the baseline for showing what an update adds or drops.
   */
  approvedNativeSurface?: StoredNativePluginSurface;
}

export interface StoredNativePluginSurface {
  apiVersion: number;
  hooks: string[];
  tools: string[];
  presets: string[];
  promptSections: string[];
  context: string[];
  background: boolean;
  coreCapabilities: string[];
  hostCapabilities: string[];
  companionPanel?: string;
}

export interface StoredPluginHookReview {
  rawEvent: string;
  matcher?: string;
  command: string;
  commandDigest: string;
  commandTruncated?: boolean;
  async?: boolean;
  timeoutMs?: number;
}

export interface InstalledPluginsV2 {
  version: 2;
  plugins: Record<string, PluginInstallEntry[]>;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

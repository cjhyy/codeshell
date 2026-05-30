/**
 * Plugin-marketplace plumbing for the Customize UI. Thin wrappers over
 * core's marketplaceManager / pluginInstaller / parseMarketplaceInput so
 * the renderer never imports core directly.
 *
 * Core does NOT re-export the marketplace shape types from its index, so
 * we mirror them as local DTOs here (same pattern as `PluginSummary` in
 * plugins-service.ts) and flatten the nested `{name,email}` author/owner
 * objects down to plain strings for the UI. Keep these in sync with core's
 * src/plugins/types.ts.
 *
 * List is never-throw (returns []) so the page still renders if the
 * known-marketplaces manifest is missing or corrupt; the mutating calls
 * surface errors as `{ ok:false, error }` (or throw on bad input) so the
 * IPC layer can report a clear message.
 */

import {
  listMarketplaces,
  loadMarketplace,
  addMarketplace,
  removeMarketplace,
  installPlugin,
  parseMarketplaceInput,
  deriveMarketplaceName,
} from "@cjhyy/code-shell-core";

// Local type mirrors (core does not re-export these). Keep in sync with core.
export type MarketplaceSource =
  | { source: "github"; repo: string }
  | { source: "git"; url: string };

export interface ListedMarketplaceDTO {
  name: string;
  source: MarketplaceSource;
  installLocation: string;
  lastUpdated: string;
  pluginCount: number;
}

export interface MarketplacePluginDTO {
  name: string;
  description?: string;
  author?: string; // flattened from {name,email}
  category?: string;
  homepage?: string;
}

export interface MarketplaceDetailDTO {
  name: string;
  description?: string;
  owner?: string; // flattened
  plugins: MarketplacePluginDTO[];
}

export function listMarketplacesForUi(): ListedMarketplaceDTO[] {
  try {
    return listMarketplaces() as ListedMarketplaceDTO[];
  } catch {
    return [];
  }
}

export function loadMarketplaceForUi(name: string): MarketplaceDetailDTO | null {
  if (typeof name !== "string" || !name) {
    throw new Error("loadMarketplaceForUi requires name");
  }
  const mp = loadMarketplace(name);
  if (!mp) return null;
  return {
    name: mp.name,
    description: mp.description,
    owner: mp.owner?.name,
    plugins: mp.plugins.map((p) => ({
      name: p.name,
      description: p.description,
      author: p.author?.name,
      category: p.category,
      homepage: p.homepage,
    })),
  };
}

/** Parse a user-typed marketplace source string (github repo / git url) and add it. */
export async function addMarketplaceFromInput(
  input: string,
): Promise<{ ok: boolean; name?: string; error?: string }> {
  if (typeof input !== "string" || !input.trim()) {
    return { ok: false, error: "请输入 GitHub 仓库或 git URL" };
  }
  const source = parseMarketplaceInput(input.trim());
  if (!source) {
    return { ok: false, error: "无法识别的市场来源（应为 owner/repo 或 git URL）" };
  }
  const name = deriveMarketplaceName(source);
  const res = await addMarketplace(name, source);
  if (res.ok) return { ok: true, name: res.name };
  return { ok: false, error: res.error };
}

export function removeMarketplaceForUi(name: string): boolean {
  if (typeof name !== "string" || !name) {
    throw new Error("removeMarketplaceForUi requires name");
  }
  return removeMarketplace(name);
}

export async function installPluginForUi(
  pluginName: string,
  marketplaceName: string,
): Promise<{ ok: boolean; error?: string }> {
  if (typeof pluginName !== "string" || !pluginName) {
    throw new Error("installPluginForUi requires pluginName");
  }
  if (typeof marketplaceName !== "string" || !marketplaceName) {
    throw new Error("installPluginForUi requires marketplaceName");
  }
  const res = await installPlugin(pluginName, marketplaceName);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

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
  refreshMarketplace,
  removeMarketplace,
  installPlugin,
  installLocalPlugin,
  parseMarketplaceInput,
  deriveMarketplaceName,
  invalidateSkillCache,
} from "@cjhyy/code-shell-core";

/**
 * Turn core's machine-readable git errors into a friendly, actionable message.
 * `GIT_NOT_FOUND:` is emitted by gitOps when no git binary is reachable — the
 * most common first-run snag (git not installed, or a GUI launch that didn't
 * inherit PATH). Anything else passes through unchanged.
 */
function humanizeGitError(error: string | undefined): string | undefined {
  if (!error) return error;
  if (error.startsWith("GIT_NOT_FOUND")) {
    return (
      "未找到 Git。安装插件市场需要 Git:请从 https://git-scm.com/downloads 安装后重启;" +
      "若已安装但仍报此错(常见于 Windows 的 PATH 问题),可在 设置 → 填写 git.path 指向 git 可执行文件。"
    );
  }
  return error;
}

// Local type mirrors (core does not re-export these). Keep in sync with core.
export type MarketplaceSource =
  | { source: "github"; repo: string }
  | { source: "git"; url: string };

export type MarketplaceFormat = "claude-code" | "codex" | "universal";

export interface ListedMarketplaceDTO {
  name: string;
  source: MarketplaceSource;
  installLocation: string;
  lastUpdated: string;
  pluginCount: number;
  format: MarketplaceFormat;
}

export interface MarketplacePluginDTO {
  name: string;
  description?: string;
  author?: string; // flattened from {name,email}
  category?: string;
  homepage?: string;
  /** Declared in the manifest when present — CC has no version convention, so often absent. */
  version?: string;
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
      version: p.version,
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
  return { ok: false, error: humanizeGitError(res.error) };
}

export function removeMarketplaceForUi(name: string): boolean {
  if (typeof name !== "string" || !name) {
    throw new Error("removeMarketplaceForUi requires name");
  }
  return removeMarketplace(name);
}

/** Re-pull a known marketplace from its source (git fetch + reset). */
export async function refreshMarketplaceForUi(
  name: string,
): Promise<{ ok: boolean; error?: string }> {
  if (typeof name !== "string" || !name) {
    throw new Error("refreshMarketplaceForUi requires name");
  }
  const res = await refreshMarketplace(name);
  if (res.ok) return { ok: true };
  return { ok: false, error: humanizeGitError(res.error) };
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
  if (res.ok) {
    // A freshly-installed plugin may ship skills; bust the scanner cache so the
    // running session's next turn sees them without a restart. The renderer
    // additionally dispatches "codeshell:settings-changed" to reload plugin
    // hooks across active sessions.
    invalidateSkillCache();
  }
  return res.ok ? { ok: true } : { ok: false, error: humanizeGitError(res.error) };
}

/**
 * Install a plugin from a local directory or a .zip archive (global scope —
 * plugins are not project-scoped). Main owns Date.now (core scripts cannot use
 * it), so we stamp installedAt here. On success bust the skill cache like the
 * marketplace path; the renderer fires "codeshell:settings-changed" to hot-load
 * any hooks the plugin ships.
 */
export async function installLocalPluginForUi(
  input: { kind: "dir" | "zip"; path: string },
): Promise<{ ok: true; name: string } | { ok: false; error?: string }> {
  if (!input || (input.kind !== "dir" && input.kind !== "zip") || typeof input.path !== "string" || !input.path) {
    throw new Error("installLocalPluginForUi requires { kind: 'dir'|'zip', path }");
  }
  try {
    const { name } = await installLocalPlugin(input, new Date().toISOString());
    invalidateSkillCache();
    return { ok: true, name };
  } catch (e) {
    return { ok: false, error: humanizeGitError(String(e instanceof Error ? e.message : e)) };
  }
}

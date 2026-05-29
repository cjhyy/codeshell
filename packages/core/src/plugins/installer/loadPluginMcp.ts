import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readInstalledPlugins } from "../installedPlugins.js";
import type { MCPServerConfig } from "../../types.js";

function pluginNameFromKey(key: string): string {
  const at = key.lastIndexOf("@");
  return at > 0 ? key.slice(0, at) : key;
}

/**
 * Read a single plugin's MCP servers, already keyed `<plugin>:<server>`.
 *
 * Two on-disk shapes are supported:
 *  - `mcp-servers.json` — the Codex-install product: already keyed + named.
 *  - `.mcp.json` — what a CC plugin ships verbatim (Docker's mcp-toolkit etc.).
 *    It uses a `{ mcpServers: {...} }` wrapper with bare server names; we unwrap
 *    it and apply the `<plugin>:` prefix + `name` so it matches the keyed shape.
 *
 * `mcp-servers.json` wins if both exist. Malformed files yield {} (must not
 * break startup).
 */
function readPluginMcp(installPath: string, pluginName: string): Record<string, MCPServerConfig> {
  const keyedPath = join(installPath, "mcp-servers.json");
  if (existsSync(keyedPath)) {
    try {
      return JSON.parse(readFileSync(keyedPath, "utf-8")) as Record<string, MCPServerConfig>;
    } catch {
      return {};
    }
  }
  const rawPath = join(installPath, ".mcp.json");
  if (existsSync(rawPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(rawPath, "utf-8"));
    } catch {
      return {};
    }
    const servers =
      parsed && typeof parsed === "object" && "mcpServers" in (parsed as object)
        ? (parsed as { mcpServers: Record<string, MCPServerConfig> }).mcpServers ?? {}
        : (parsed as Record<string, MCPServerConfig>) ?? {};
    const keyed: Record<string, MCPServerConfig> = {};
    for (const [serverName, cfg] of Object.entries(servers)) {
      const key = `${pluginName}:${serverName}`;
      keyed[key] = { ...(cfg as object), name: key } as MCPServerConfig;
    }
    return keyed;
  }
  return {};
}

/**
 * Merge each registered plugin's MCP servers into a copy of `base`.
 * Plugin keys are `<plugin>:<server>`. A key already present in `base`
 * (user-configured) is NOT overwritten. Disabled plugins are skipped.
 */
export function mergePluginMcpServers(
  base: Record<string, MCPServerConfig>,
  disabledPlugins: string[] = [],
): Record<string, MCPServerConfig> {
  const disabled = new Set(disabledPlugins);
  const merged: Record<string, MCPServerConfig> = { ...base };
  const data = readInstalledPlugins();
  for (const [key, entries] of Object.entries(data.plugins)) {
    const pluginName = pluginNameFromKey(key);
    if (disabled.has(pluginName)) continue;
    for (const entry of entries) {
      const servers = readPluginMcp(entry.installPath, pluginName);
      for (const [k, cfg] of Object.entries(servers)) {
        if (k in merged) continue; // user / earlier wins
        merged[k] = cfg;
      }
    }
  }
  return merged;
}

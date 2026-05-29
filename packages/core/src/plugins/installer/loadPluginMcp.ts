import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readInstalledPlugins } from "../installedPlugins.js";
import type { MCPServerConfig } from "../../types.js";

function pluginNameFromKey(key: string): string {
  const at = key.lastIndexOf("@");
  return at > 0 ? key.slice(0, at) : key;
}

/**
 * Merge each registered plugin's mcp-servers.json into a copy of `base`.
 * Plugin keys are already `<plugin>:<server>`. A key already present in `base`
 * (user-configured) is NOT overwritten. Disabled plugins are skipped. A
 * malformed plugin mcp file is skipped — it must not break startup.
 */
export function mergePluginMcpServers(
  base: Record<string, MCPServerConfig>,
  disabledPlugins: string[] = [],
): Record<string, MCPServerConfig> {
  const disabled = new Set(disabledPlugins);
  const merged: Record<string, MCPServerConfig> = { ...base };
  const data = readInstalledPlugins();
  for (const [key, entries] of Object.entries(data.plugins)) {
    if (disabled.has(pluginNameFromKey(key))) continue;
    for (const entry of entries) {
      const path = join(entry.installPath, "mcp-servers.json");
      if (!existsSync(path)) continue;
      let servers: Record<string, MCPServerConfig>;
      try {
        servers = JSON.parse(readFileSync(path, "utf-8"));
      } catch {
        continue;
      }
      for (const [k, cfg] of Object.entries(servers)) {
        if (k in merged) continue; // user / earlier wins
        merged[k] = cfg;
      }
    }
  }
  return merged;
}

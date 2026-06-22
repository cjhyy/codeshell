import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readInstalledPlugins } from "../installedPlugins.js";
import type { MCPServerConfig, MCPServerOverride } from "../../types.js";

function pluginNameFromKey(key: string): string {
  const at = key.lastIndexOf("@");
  return at > 0 ? key.slice(0, at) : key;
}

/**
 * Layer a user override's supplement fields onto a plugin server config.
 *
 * Only env/credential fields are picked — command/args/url/transport are
 * deliberately NOT carried, because those are the plugin's identity and must
 * keep coming from the plugin manifest so a plugin update can change them
 * without the user being stuck on a stale shadow copy. This explicit pick is
 * defense-in-depth on top of the schema's `.strict()`, so a hand-edited
 * settings file can never smuggle those fields in.
 */
function applyOverride(
  pluginConfig: MCPServerConfig,
  override: MCPServerOverride | undefined,
): MCPServerConfig {
  if (!override) return pluginConfig;
  const supplement: MCPServerOverride = {};
  if (override.env !== undefined) supplement.env = override.env;
  if (override.envVars !== undefined) supplement.envVars = override.envVars;
  if (override.credentialRef !== undefined) supplement.credentialRef = override.credentialRef;
  if (override.bearerTokenEnvVar !== undefined)
    supplement.bearerTokenEnvVar = override.bearerTokenEnvVar;
  if (override.envHeaders !== undefined) supplement.envHeaders = override.envHeaders;
  return { ...pluginConfig, ...supplement };
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
 *
 * `overrides` lets the user *supplement* a plugin server's env/credential
 * fields without editing the plugin's manifest: for a plugin-sourced server,
 * the override's {@link OVERRIDE_FIELDS} are layered on top (override wins),
 * while command/args/url/transport stay from the plugin. Overrides do NOT
 * apply to user-added (base) servers — those are edited via `mcpServers`
 * directly — and an override for an unknown/disabled server has no effect.
 */
export function mergePluginMcpServers(
  base: Record<string, MCPServerConfig>,
  disabledPlugins: string[] = [],
  overrides: Record<string, MCPServerOverride> = {},
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
        merged[k] = applyOverride(cfg, overrides[k]);
      }
    }
  }
  return merged;
}

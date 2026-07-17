import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { readInstalledPlugins } from "../installedPlugins.js";
import { pluginMcpApprovalState } from "../pluginMcpIntegrity.js";
import type { MCPServerConfig, MCPServerOverride } from "../../types.js";

function pluginNameFromKey(key: string): string {
  const at = key.lastIndexOf("@");
  return at > 0 ? key.slice(0, at) : key;
}

const MAX_PLUGIN_MCP_CONFIG_BYTES = 1024 * 1024;
const MAX_PLUGIN_MCP_SERVERS = 64;
const MAX_SERVER_NAME_LENGTH = 96;
const MAX_COMMAND_LENGTH = 4096;
const MAX_URL_LENGTH = 2048;
const MAX_ARGS = 256;
const MAX_RECORD_ENTRIES = 128;
const MAX_VALUE_LENGTH = 8192;
const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HTTP_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const PLUGIN_TRANSPORTS = new Set(["stdio", "sse", "streamable-http"]);

function readContainedPluginJson(installPath: string, fileName: string): unknown | null {
  try {
    const root = realpathSync(installPath);
    const candidate = join(installPath, fileName);
    const linkInfo = lstatSync(candidate);
    if (
      linkInfo.isSymbolicLink() ||
      !linkInfo.isFile() ||
      linkInfo.size > MAX_PLUGIN_MCP_CONFIG_BYTES
    ) {
      return null;
    }
    const target = realpathSync(candidate);
    const rel = relative(root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    const info = statSync(target);
    if (!info.isFile() || info.size > MAX_PLUGIN_MCP_CONFIG_BYTES) return null;
    return JSON.parse(readFileSync(target, "utf-8"));
  } catch {
    return null;
  }
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : undefined;
}

function boundedStringArray(
  value: unknown,
  maxItems: number,
  maxLength: number,
  validate?: (item: string) => boolean,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  const items: string[] = [];
  for (const item of value) {
    const stringValue = boundedString(item, maxLength);
    if (!stringValue || (validate && !validate(stringValue))) return undefined;
    items.push(stringValue);
  }
  return items;
}

function boundedStringRecord(
  value: unknown,
  validateKey?: (key: string) => boolean,
  validateValue?: (value: string) => boolean,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > MAX_RECORD_ENTRIES) return undefined;
  const result: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (
      key.length === 0 ||
      key.length > 256 ||
      key.includes("\0") ||
      (validateKey && !validateKey(key))
    ) {
      return undefined;
    }
    const stringValue =
      typeof item === "string" && item.length <= MAX_VALUE_LENGTH ? item : undefined;
    if (
      stringValue === undefined ||
      stringValue.includes("\0") ||
      (validateValue && !validateValue(stringValue))
    ) {
      return undefined;
    }
    result[key] = stringValue;
  }
  return result;
}

function safeHttpUrl(value: unknown): string | undefined {
  const raw = boundedString(value, MAX_URL_LENGTH);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    return raw;
  } catch {
    return undefined;
  }
}

/**
 * Turn one untrusted plugin MCP declaration into the narrow runtime shape.
 * Unknown fields are dropped; malformed known fields reject the whole server
 * instead of reaching MCPManager and failing during application startup.
 */
function normalizePluginMcpServer(raw: unknown, key: string): MCPServerConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const cfg = raw as Record<string, unknown>;

  const transport =
    cfg.transport === undefined
      ? undefined
      : typeof cfg.transport === "string" && PLUGIN_TRANSPORTS.has(cfg.transport)
        ? (cfg.transport as MCPServerConfig["transport"])
        : null;
  if (transport === null) return undefined;

  const command =
    cfg.command === undefined ? undefined : boundedString(cfg.command, MAX_COMMAND_LENGTH);
  if (cfg.command !== undefined && !command) return undefined;
  if (command?.includes("\0")) return undefined;

  const url = cfg.url === undefined ? undefined : safeHttpUrl(cfg.url);
  if (cfg.url !== undefined && !url) return undefined;

  const args = boundedStringArray(cfg.args, MAX_ARGS, MAX_VALUE_LENGTH, (item) => {
    return !item.includes("\0");
  });
  if (cfg.args !== undefined && !args) return undefined;

  const env = boundedStringRecord(cfg.env, (name) => ENV_NAME_RE.test(name));
  if (cfg.env !== undefined && !env) return undefined;
  const headers = boundedStringRecord(
    cfg.headers,
    (name) => HTTP_HEADER_NAME_RE.test(name),
    (value) => !value.includes("\r") && !value.includes("\n"),
  );
  if (cfg.headers !== undefined && !headers) return undefined;
  const envHeaders = boundedStringRecord(
    cfg.envHeaders,
    (name) => HTTP_HEADER_NAME_RE.test(name),
    (envName) => ENV_NAME_RE.test(envName),
  );
  if (cfg.envHeaders !== undefined && !envHeaders) return undefined;

  const envVars = boundedStringArray(cfg.envVars, MAX_RECORD_ENTRIES, 256, (name) =>
    ENV_NAME_RE.test(name),
  );
  if (cfg.envVars !== undefined && !envVars) return undefined;

  const bearerTokenEnvVar =
    cfg.bearerTokenEnvVar === undefined ? undefined : boundedString(cfg.bearerTokenEnvVar, 256);
  if (
    cfg.bearerTokenEnvVar !== undefined &&
    (!bearerTokenEnvVar || !ENV_NAME_RE.test(bearerTokenEnvVar))
  ) {
    return undefined;
  }

  const credentialRef =
    cfg.credentialRef === undefined ? undefined : boundedString(cfg.credentialRef, 256);
  if (cfg.credentialRef !== undefined && !credentialRef) return undefined;
  if (cfg.enabled !== undefined && typeof cfg.enabled !== "boolean") return undefined;
  const allowedToolsRaw = cfg.allowedTools ?? cfg.allowed_tools;
  const disabledToolsRaw = cfg.disabledTools ?? cfg.disabled_tools;
  const allowedTools = boundedStringArray(allowedToolsRaw, 256, 256, (name) => {
    return !name.includes("\0");
  });
  if (allowedToolsRaw !== undefined && !allowedTools) return undefined;
  const disabledTools = boundedStringArray(disabledToolsRaw, 256, 256, (name) => {
    return !name.includes("\0");
  });
  if (disabledToolsRaw !== undefined && !disabledTools) return undefined;

  const effectiveTransport = transport ?? (url && !command ? "streamable-http" : "stdio");
  if (effectiveTransport === "stdio" && !command) return undefined;
  if ((effectiveTransport === "sse" || effectiveTransport === "streamable-http") && !url) {
    return undefined;
  }

  return {
    name: key,
    ...(command ? { command } : {}),
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    ...(url ? { url } : {}),
    ...(transport ? { transport } : {}),
    ...(headers ? { headers } : {}),
    ...(envVars ? { envVars } : {}),
    ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}),
    ...(envHeaders ? { envHeaders } : {}),
    ...(credentialRef ? { credentialRef } : {}),
    ...(typeof cfg.enabled === "boolean" ? { enabled: cfg.enabled } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(disabledTools ? { disabledTools } : {}),
  };
}

export function normalizePluginMcpMap(
  raw: unknown,
  pluginName: string,
  alreadyKeyed: boolean,
): Record<string, MCPServerConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries = Object.entries(raw);
  if (entries.length > MAX_PLUGIN_MCP_SERVERS) return {};

  const keyed: Record<string, MCPServerConfig> = {};
  for (const [declaredName, config] of entries) {
    const serverName = alreadyKeyed
      ? declaredName.startsWith(`${pluginName}:`)
        ? declaredName.slice(pluginName.length + 1)
        : ""
      : declaredName;
    if (
      serverName.length === 0 ||
      serverName.length > MAX_SERVER_NAME_LENGTH ||
      !SERVER_NAME_RE.test(serverName)
    ) {
      continue;
    }
    const key = `${pluginName}:${serverName}`;
    const normalized = normalizePluginMcpServer(config, key);
    if (normalized) keyed[key] = normalized;
  }
  return keyed;
}

/**
 * Layer a user override's supplement fields onto a plugin server config.
 *
 * Only the user server/tool policy and env/credential fields are picked —
 * command/args/url/transport are deliberately NOT carried, because those are
 * the plugin's identity and must keep coming from the plugin manifest so an
 * update can change them without the user being stuck on a stale shadow copy.
 * This explicit pick is defense-in-depth on top of the schema's `.strict()`,
 * so a hand-edited settings file can never smuggle identity fields in.
 */
function applyOverride(
  pluginConfig: MCPServerConfig,
  override: MCPServerOverride | undefined,
): MCPServerConfig {
  if (!override) return pluginConfig;
  const supplement: MCPServerOverride = {};
  if (override.enabled !== undefined) supplement.enabled = override.enabled;
  if (override.allowedTools !== undefined) supplement.allowedTools = override.allowedTools;
  if (override.disabledTools !== undefined) supplement.disabledTools = override.disabledTools;
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
export function readPluginMcp(
  installPath: string,
  pluginName: string,
): Record<string, MCPServerConfig> {
  let keyedPresent = false;
  try {
    lstatSync(join(installPath, "mcp-servers.json"));
    keyedPresent = true;
  } catch {
    // Missing: the CC-compatible .mcp.json fallback may be used.
  }
  const keyed = readContainedPluginJson(installPath, "mcp-servers.json");
  if (keyed && typeof keyed === "object" && !Array.isArray(keyed)) {
    return normalizePluginMcpMap(keyed, pluginName, true);
  }
  if (keyedPresent) return {};
  const parsed = readContainedPluginJson(installPath, ".mcp.json");
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const servers =
      "mcpServers" in parsed ? ((parsed as { mcpServers?: unknown }).mcpServers ?? {}) : parsed;
    return normalizePluginMcpMap(servers, pluginName, false);
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
      const approval = pluginMcpApprovalState(entry, Object.keys(servers).length > 0);
      if (approval === "pending" || approval === "changed" || approval === "none") continue;
      for (const [k, cfg] of Object.entries(servers)) {
        if (k in merged) continue; // user / earlier wins
        merged[k] = applyOverride(cfg, overrides[k]);
      }
    }
  }
  return merged;
}

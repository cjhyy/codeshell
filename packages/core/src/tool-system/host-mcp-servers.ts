/**
 * Host-owned MCP servers.
 *
 * Desktop main can own an MCP server whose lifecycle it supervises (for
 * example the embedded Cua Driver daemon) without writing it into the user's
 * settings.json. Main encodes the declarations into one env var on every
 * worker spawn; the worker merges them after user and plugin servers, so a
 * user-configured server with the same name always wins.
 *
 * Only stdio declarations are accepted: the host spawns its own private
 * transports and never forwards URLs or credentials through this channel.
 */
import type { MCPServerConfig } from "../types.js";

export const HOST_MCP_SERVERS_ENV = "CODE_SHELL_HOST_MCP_SERVERS";

export interface HostMcpServerDeclaration {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly inlineImages?: boolean;
  readonly allowedTools?: readonly string[];
}

const NAME_PATTERN = /^host:[A-Za-z0-9_.-]+$/;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

/** Serialize declarations for the worker env. Names must use the `host:` prefix. */
export function encodeHostMcpServers(
  servers: Readonly<Record<string, HostMcpServerDeclaration>>,
): string {
  for (const name of Object.keys(servers)) {
    if (!NAME_PATTERN.test(name)) throw new Error(`invalid host MCP server name: ${name}`);
  }
  return JSON.stringify(servers);
}

/**
 * Parse the env var. Malformed input yields no servers rather than a partial
 * set, so a bad host value can never smuggle in a half-validated entry.
 */
export function readHostMcpServers(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, MCPServerConfig> {
  const raw = env[HOST_MCP_SERVERS_ENV];
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, MCPServerConfig> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!NAME_PATTERN.test(name)) return {};
    if (typeof value !== "object" || value === null) return {};
    const decl = value as Record<string, unknown>;
    if (typeof decl.command !== "string" || decl.command.length === 0) return {};
    if (decl.args !== undefined && !isStringArray(decl.args)) return {};
    if (decl.env !== undefined && !isStringRecord(decl.env)) return {};
    if (decl.inlineImages !== undefined && typeof decl.inlineImages !== "boolean") return {};
    if (decl.allowedTools !== undefined && !isStringArray(decl.allowedTools)) return {};
    out[name] = {
      name,
      transport: "stdio",
      command: decl.command,
      ...(decl.args ? { args: [...decl.args] } : {}),
      ...(decl.env ? { env: { ...decl.env } } : {}),
      ...(decl.inlineImages ? { inlineImages: true } : {}),
      ...(decl.allowedTools ? { allowedTools: [...decl.allowedTools] } : {}),
    };
  }
  return out;
}

/** Add host servers to an already merged map without overriding existing names. */
export function withHostMcpServers(
  merged: Record<string, MCPServerConfig>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, MCPServerConfig> {
  for (const [name, config] of Object.entries(readHostMcpServers(env))) {
    if (!(name in merged)) merged[name] = config;
  }
  return merged;
}

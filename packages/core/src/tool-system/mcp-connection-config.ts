import { createHash } from "node:crypto";
import type { MCPServerConfig } from "../types.js";
import {
  DEFAULT_MCP_CONNECT_RETRIES,
  DEFAULT_MCP_CONNECT_TIMEOUT_MS,
} from "./mcp-connection-policy.js";

/** A connection declaration is private host data, never a model-visible id. */
export interface McpConnectionConfig {
  readonly identity: string;
  readonly config: MCPServerConfig;
}

function sortedEntries(value?: Record<string, string>): Array<[string, string]> {
  return Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b));
}

// Header names are case-insensitive. Preserve declaration order only when it
// actually affects precedence (for example both X-Key and x-key are present).
function headerEntries(value?: Record<string, string>): Array<[string, string]> {
  const entries = Object.entries(value ?? {});
  return new Set(entries.map(([name]) => name.toLowerCase())).size === entries.length
    ? entries.sort(([a], [b]) => a.localeCompare(b))
    : entries;
}

/** Freeze caller-owned arrays/maps before a handshake or another Run can await. */
export function snapshotMcpConnectionConfig(config: MCPServerConfig): McpConnectionConfig {
  const snapshot = structuredClone(config);
  // enabled and tool policy belong to each Run, not a shared transport. Named
  // credential values keep the existing per-request refresh/rotation contract.
  const declaration = {
    transport:
      snapshot.transport ?? (snapshot.url && !snapshot.command ? "streamable-http" : "stdio"),
    command: snapshot.command,
    args: snapshot.args ?? [],
    env: sortedEntries(snapshot.env),
    envVars: [...new Set(snapshot.envVars ?? [])].sort(),
    url: snapshot.url,
    headers: headerEntries(snapshot.headers),
    envHeaders: headerEntries(snapshot.envHeaders),
    bearerTokenEnvVar: snapshot.bearerTokenEnvVar,
    credentialRef: snapshot.credentialRef,
    connectTimeoutMs: snapshot.connectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS,
    connectRetries: snapshot.connectRetries ?? DEFAULT_MCP_CONNECT_RETRIES,
    // Result delivery is read from the connection's config, so two
    // declarations that differ only here must not share a transport. Added
    // only when set so existing identities stay unchanged.
    ...(snapshot.inlineImages === true ? { inlineImages: true } : {}),
  };
  const identity = createHash("sha256").update(JSON.stringify(declaration)).digest("hex");
  return { identity, config: snapshot };
}

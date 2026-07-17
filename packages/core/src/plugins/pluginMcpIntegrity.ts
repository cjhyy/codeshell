import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginInstallEntry } from "./types.js";

const DIGEST_DOMAIN = "codeshell-plugin-mcp-v1";
const ABSENT_MCP = "<absent>";
const UNSAFE_MCP = "<unsafe>";
const MAX_PLUGIN_MCP_CONFIG_BYTES = 1024 * 1024;

function effectiveMcpBytes(installPath: string): Buffer | string {
  for (const fileName of ["mcp-servers.json", ".mcp.json"]) {
    const path = join(installPath, fileName);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(path);
    } catch {
      // mcp-servers.json wins when present; otherwise try the CC fallback.
      continue;
    }
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_PLUGIN_MCP_CONFIG_BYTES) {
      return `${UNSAFE_MCP}:${fileName}`;
    }
    try {
      return Buffer.concat([Buffer.from(`${fileName}\0`), readFileSync(path)]);
    } catch {
      return `${UNSAFE_MCP}:${fileName}`;
    }
  }
  return ABSENT_MCP;
}

/**
 * Digest the exact effective declaration selected by the runtime. The file
 * name is part of the digest so switching between native and CC shapes cannot
 * inherit approval accidentally.
 */
export function pluginMcpDigest(installPath: string): string {
  return createHash("sha256")
    .update(DIGEST_DOMAIN)
    .update("\0")
    .update(effectiveMcpBytes(installPath))
    .digest("hex");
}

export type PluginMcpIntegrity = "verified" | "changed" | "legacy";
export type PluginMcpApprovalState = "approved" | "pending" | "changed" | "legacy" | "none";

export function verifyPluginMcpIntegrity(entry: PluginInstallEntry): PluginMcpIntegrity {
  if (!entry.mcpDigest) return "legacy";
  return pluginMcpDigest(entry.installPath) === entry.mcpDigest ? "verified" : "changed";
}

/**
 * Compute trust for one install. The caller supplies whether the declaration
 * currently normalizes to at least one runnable MCP server, keeping the trust
 * layer coupled to the runtime's strict schema rather than a second parser.
 */
export function pluginMcpApprovalState(
  entry: PluginInstallEntry,
  hasMcpServers: boolean,
): PluginMcpApprovalState {
  const integrity = verifyPluginMcpIntegrity(entry);
  if (integrity === "changed") return "changed";
  if (!hasMcpServers) return "none";
  if (integrity === "legacy") return "legacy";
  return entry.approvedMcpDigest === entry.mcpDigest ? "approved" : "pending";
}

/**
 * Fields written at install/update. Installs with runnable MCP servers start
 * pending; an explicitly approved identical digest survives an update.
 */
export function pluginMcpInstallRecord(
  installPath: string,
  hasMcpServers: boolean,
  previousEntries: PluginInstallEntry[] = [],
): Pick<PluginInstallEntry, "mcpDigest" | "approvedMcpDigest"> {
  const mcpDigest = pluginMcpDigest(installPath);
  const previouslyApproved = previousEntries.some(
    (entry) => entry.mcpDigest === mcpDigest && entry.approvedMcpDigest === entry.mcpDigest,
  );
  return {
    mcpDigest,
    ...(!hasMcpServers || previouslyApproved ? { approvedMcpDigest: mcpDigest } : {}),
  };
}

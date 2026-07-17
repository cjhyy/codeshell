import type { MCPServerConfig, RegisteredTool } from "../types.js";

export interface McpToolPolicy {
  /** Undefined means every tool is eligible before the denylist is applied. */
  allowedTools?: ReadonlySet<string>;
  disabledTools: ReadonlySet<string>;
}

export function buildMcpToolPolicies(
  servers: Record<string, MCPServerConfig>,
): ReadonlyMap<string, McpToolPolicy> {
  const policies = new Map<string, McpToolPolicy>();
  for (const [serverName, config] of Object.entries(servers)) {
    if (config.enabled === false) continue;
    if (config.allowedTools === undefined && config.disabledTools === undefined) continue;
    policies.set(serverName, {
      allowedTools:
        config.allowedTools === undefined ? undefined : new Set<string>(config.allowedTools),
      disabledTools: new Set<string>(config.disabledTools ?? []),
    });
  }
  return policies;
}

export function isMcpToolNameAllowed(
  policies: ReadonlyMap<string, McpToolPolicy> | undefined,
  serverName: string,
  toolName: string,
): boolean {
  const policy = policies?.get(serverName);
  if (!policy) return true;
  if (policy.allowedTools && !policy.allowedTools.has(toolName)) return false;
  return !policy.disabledTools.has(toolName);
}

export function isRegisteredMcpToolAllowed(
  tool: Pick<RegisteredTool, "source" | "serverName" | "mcpToolName">,
  policies: ReadonlyMap<string, McpToolPolicy> | undefined,
): boolean {
  if (tool.source !== "mcp") return true;
  const policy = policies?.get(tool.serverName ?? "");
  if (!policy) return true;
  // Restricted servers fail closed for registry entries created by an older
  // or third-party adapter that did not preserve the original MCP tool name.
  if (!tool.mcpToolName) return false;
  return isMcpToolNameAllowed(policies, tool.serverName ?? "", tool.mcpToolName);
}

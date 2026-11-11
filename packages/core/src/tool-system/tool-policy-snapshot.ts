import type { ToolDefinition } from "../types.js";
import { PLAN_MODE_ALLOWED_TOOLS } from "./plan-mode-allowlist.js";

/** Credential-free, serializable MCP authority for an already registered server. */
export interface McpPolicySnapshot {
  serverName: string;
  allowedTools?: readonly string[];
  disabledTools: readonly string[];
}

/** Guards and definition rewriters are evaluated by the host before this boundary. */
export interface PreparedToolDefinition {
  definition: ToolDefinition;
  available: boolean;
  featureEnabled: boolean;
  mcp?: { serverName: string; toolName?: string };
}

/**
 * Only data crosses the shared policy boundary: no registry, callbacks, ToolContext,
 * settings readers, transport credentials, or native model-loop state.
 */
export interface ToolPolicyInputSnapshot {
  tools: readonly PreparedToolDefinition[];
  disabledBuiltinNames: readonly string[];
  allowedToolNames?: readonly string[];
  allowedMcpServers: readonly string[];
  mcpPolicies: readonly McpPolicySnapshot[];
  planMode: boolean;
}

/** Pure eligibility projection shared by native model requests and external discovery. */
export function resolveToolPolicySnapshot(snapshot: ToolPolicyInputSnapshot): ToolDefinition[] {
  const disabled = new Set(snapshot.disabledBuiltinNames);
  const allowed = snapshot.allowedToolNames && new Set(snapshot.allowedToolNames);
  const servers = new Set(snapshot.allowedMcpServers);
  const policies = new Map(snapshot.mcpPolicies.map((policy) => [policy.serverName, policy]));
  const definitions = snapshot.tools
    .filter(({ definition, available, featureEnabled, mcp }) => {
      const name = definition.name;
      if (!available || !featureEnabled || disabled.has(name)) return false;
      if (allowed && !allowed.has(name)) return false;
      if (snapshot.planMode && !PLAN_MODE_ALLOWED_TOOLS.has(name)) return false;
      if (!mcp) return true;
      if (!servers.has(mcp.serverName)) return false;
      const policy = policies.get(mcp.serverName);
      if (!policy) return true;
      // Restricted legacy adapters without original MCP names fail closed.
      if (!mcp.toolName) return false;
      if (policy.allowedTools && !policy.allowedTools.includes(mcp.toolName)) return false;
      return !policy.disabledTools.includes(mcp.toolName);
    })
    .map(({ definition }) => definition);
  return definitions.filter(
    (tool) => tool.name !== "CallTool" || definitions.some((entry) => entry.name === "ToolSearch"),
  );
}

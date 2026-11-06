import type { MCPServerConfig } from "../types.js";
import type { AgentDefinitionRegistry } from "../agent/agent-definition-registry.js";
import { isFeatureEnabled, type FeatureFlagOverrides } from "../settings/feature-flags.js";
import { applyDynamicToolDef } from "./dynamic-tool-defs.js";
import type { ToolVisibilityContext } from "./context.js";
import type { ToolRegistry } from "./registry.js";
import { buildMcpToolPolicies } from "./mcp-tool-policy.js";
import { resolveToolPolicySnapshot, type ToolPolicyInputSnapshot } from "./tool-policy-snapshot.js";

export interface PrepareToolPolicyOptions {
  registry: ToolRegistry;
  visibility: ToolVisibilityContext;
  disabledBuiltinNames: Iterable<string>;
  allowedToolNames?: Iterable<string>;
  mcpServers: Record<string, MCPServerConfig>;
  mcpDisabled: boolean;
  featureFlags: FeatureFlagOverrides | undefined;
  agentDefinitions?: AgentDefinitionRegistry;
  planMode: boolean;
}

/**
 * Host preparation may consult local services through catalog callbacks. Resolve
 * them here, once, then hand the pure policy resolver ordinary detached JSON.
 */
export function prepareToolPolicySnapshot(
  options: PrepareToolPolicyOptions,
): ToolPolicyInputSnapshot {
  const policies = buildMcpToolPolicies(options.mcpServers);
  const disabled = new Set(options.disabledBuiltinNames);
  const snapshot: ToolPolicyInputSnapshot = {
    tools: options.registry.getToolDefinitions().map((definition) => {
      const registered = options.registry.getTool(definition.name)!;
      const exposure = options.registry.getExposure(definition.name);
      return {
        definition,
        available: true,
        featureEnabled:
          !exposure?.featureFlag || isFeatureEnabled(options.featureFlags, exposure.featureFlag),
        ...(registered.source === "mcp"
          ? {
              mcp: {
                serverName: registered.serverName ?? "",
                ...(registered.mcpToolName ? { toolName: registered.mcpToolName } : {}),
              },
            }
          : {}),
      };
    }),
    disabledBuiltinNames: [...disabled],
    ...(options.allowedToolNames ? { allowedToolNames: [...options.allowedToolNames] } : {}),
    allowedMcpServers: options.mcpDisabled
      ? []
      : Object.entries(options.mcpServers)
          .filter(([, config]) => config.enabled !== false)
          .map(([name]) => name),
    mcpPolicies: [...policies].map(([serverName, policy]) => ({
      serverName,
      ...(policy.allowedTools ? { allowedTools: [...policy.allowedTools] } : {}),
      disabledTools: [...policy.disabledTools],
    })),
    planMode: options.planMode,
  };
  const structurallyEligible = new Set(
    resolveToolPolicySnapshot(snapshot).map((tool) => tool.name),
  );
  for (const prepared of snapshot.tools) {
    if (!structurallyEligible.has(prepared.definition.name)) continue;
    // Native-only or otherwise excluded tools must not consult services that
    // this caller does not own, even merely to decide their availability.
    const exposure = options.registry.getExposure(prepared.definition.name);
    prepared.available = exposure?.availability?.(options.visibility) ?? true;
    if (!prepared.available) continue;
    const rewrite = exposure?.rewriteDefinition;
    // Give a rewriter its own schema; even an accidental mutation must not alter
    // the worker-shared registry or a different session's advertised tools.
    const definition = structuredClone(prepared.definition);
    prepared.definition = applyDynamicToolDef(
      rewrite ? rewrite(definition, options.visibility) : definition,
      options.agentDefinitions,
      options.visibility.cwd,
    );
  }
  // Schemas are JSON protocol data. Detach nested objects and omit optional
  // undefined fields, ensuring this boundary survives a JSON round trip.
  return JSON.parse(JSON.stringify(snapshot)) as ToolPolicyInputSnapshot;
}

/** Reconstitute executor-only sets after resolving the serializable snapshot. */
export function snapshotMcpToolPolicies(snapshot: ToolPolicyInputSnapshot) {
  return new Map(
    snapshot.mcpPolicies.map((policy) => [
      policy.serverName,
      {
        ...(policy.allowedTools ? { allowedTools: new Set(policy.allowedTools) } : {}),
        disabledTools: new Set(policy.disabledTools),
      },
    ]),
  );
}

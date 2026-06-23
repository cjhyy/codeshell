/**
 * Registration-time guard for tool path-policy metadata.
 *
 * A tool's `pathPolicy[].arg` names the input field that carries a file path
 * (or, for apply_patch, the patch text). ToolExecutor reads `args[policy.arg]`
 * to find the targets it must run through the path-permission layer. If that
 * arg name is a typo (e.g. `"pat"` instead of `"path"`), the lookup yields
 * `undefined`, the executor finds zero targets, and the tool runs with NO path
 * protection and no error — a silent security failure (assessment §4.1).
 *
 * This validator catches that drift at registration time by asserting every
 * declared `pathPolicy.arg` exists in the tool's `inputSchema.properties`.
 */

import type { RegisteredTool, ToolDefinition } from "../types.js";

/** A tool-shaped object carrying the fields this validator inspects. */
type ToolLike = Pick<RegisteredTool, "name" | "inputSchema"> &
  Partial<Pick<RegisteredTool, "pathPolicy">>;

export interface ToolMetadataIssue {
  tool: string;
  arg: string;
  reason: string;
}

/**
 * Return the set of property names declared in a JSON-schema-ish object's
 * `properties`. Tolerant of missing/malformed schema (returns empty set), so a
 * tool with no declared properties is treated as "declares nothing" rather
 * than throwing — the caller decides how to react.
 */
function schemaPropertyNames(inputSchema: Record<string, unknown> | undefined): Set<string> {
  const props = inputSchema?.properties;
  if (!props || typeof props !== "object") return new Set();
  return new Set(Object.keys(props as Record<string, unknown>));
}

/**
 * Check a single tool's path-policy metadata against its schema. Returns one
 * issue per `pathPolicy.arg` that is not a declared input property. Tools
 * without a pathPolicy produce no issues.
 */
export function findToolMetadataIssues(tool: ToolLike): ToolMetadataIssue[] {
  const policies = tool.pathPolicy;
  if (!policies || policies.length === 0) return [];
  const declared = schemaPropertyNames(tool.inputSchema);
  const issues: ToolMetadataIssue[] = [];
  for (const policy of policies) {
    if (!declared.has(policy.arg)) {
      issues.push({
        tool: tool.name,
        arg: policy.arg,
        reason: `pathPolicy.arg "${policy.arg}" is not a property of inputSchema (path-permission enforcement would silently no-op)`,
      });
    }
  }
  return issues;
}

/**
 * Assert a tool's path-policy metadata is consistent with its schema. Throws on
 * the first drift. Call at registration time so a typo fails loud instead of
 * silently disabling path protection.
 */
export function validateToolMetadata(tool: ToolLike): void {
  const issues = findToolMetadataIssues(tool);
  if (issues.length > 0) {
    const first = issues[0]!;
    throw new Error(`Invalid tool metadata for "${first.tool}": ${first.reason}`);
  }
}

/** Validate a batch; returns every issue across all tools (does not throw). */
export function collectToolMetadataIssues(
  tools: ReadonlyArray<ToolLike | ToolDefinition>,
): ToolMetadataIssue[] {
  return tools.flatMap((t) => findToolMetadataIssues(t as ToolLike));
}

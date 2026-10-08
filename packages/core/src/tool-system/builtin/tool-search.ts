/** Built-in ToolSearch — discover eligible tools and load selected schemas for this run. */

import type { ToolDefinition, RegisteredTool } from "../../types.js";
import type { ToolRegistry } from "../registry.js";
import type { ToolContext } from "../context.js";
import { isRegisteredMcpToolAllowed } from "../mcp-tool-policy.js";
import { browserDiscoveryScore, isBuiltinBrowserTool } from "../browser-discovery.js";
import { PLAN_MODE_ALLOWED_TOOLS } from "../plan-mode-allowlist.js";
import { formatMcpConnectionFailures } from "../mcp-health.js";

const MAX_QUERY_LENGTH = 2048;
const MAX_RESULTS = 20;
const MAX_PURPOSE_LENGTH = 180;
const MAX_SERVER_DISPLAY_LENGTH = 120;
const MAX_OUTPUT_LENGTH = 8192;
const MAX_HEALTH_LENGTH = 2048;
const METADATA_SEPARATOR = "\n\n---\n\n";
const OMITTED_METADATA_NOTICE =
  "Some matching tools were omitted because their metadata exceeds the output budget.";

export const toolSearchToolDef: ToolDefinition = {
  name: "ToolSearch",
  description:
    "Find tools available in the current Session context by name or keyword. " +
    "Keyword searches return compact metadata and schemaRef values. " +
    'Use "select:ToolName" (or comma-separated names) to load full schemas into the next ' +
    "model request for this run. If an exact tool is reported unavailable, " +
    "do not retry unless the Session context changes.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        maxLength: MAX_QUERY_LENGTH,
        description:
          'Keywords to find tools, or "select:Name1,Name2" to load at most 20 exact tools.',
      },
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: MAX_RESULTS,
        description: "Maximum keyword results to return (default: 5, maximum: 20)",
      },
    },
    required: ["query"],
  },
};

export async function toolSearchTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  if (typeof args.query !== "string" || !args.query.trim()) {
    return "Error: query is required and must be a non-empty string";
  }
  if (args.query.length > MAX_QUERY_LENGTH) {
    return `Error: query must be at most ${MAX_QUERY_LENGTH} characters`;
  }
  const query = args.query.trim();
  const currentDefinitions = ctx?.runToolSurface?.getCatalog() ?? ctx?.searchableToolDefinitions;
  if (!ctx || (!currentDefinitions && !ctx.toolRegistry)) {
    return "Error: ToolSearch is not configured (no registry in ctx)";
  }

  const rawMax = args.max_results;
  const maxResults =
    typeof rawMax === "number" && Number.isSafeInteger(rawMax) && rawMax > 0
      ? Math.min(rawMax, MAX_RESULTS)
      : 5;
  const queryLower = query.toLowerCase();
  const failures = new Map(
    [...(ctx.mcpServerFailures ?? [])].filter(([server]) => {
      if (ctx.allowedMcpServers && !ctx.allowedMcpServers.has(server)) return false;
      return (
        queryLower.includes("mcp") ||
        server
          .toLowerCase()
          .split(":")
          .some((part) => part.length > 0 && queryLower.includes(part))
      );
    }),
  );
  const health = truncateText(formatMcpConnectionFailures(failures), MAX_HEALTH_LENGTH);
  const resultBudget = MAX_OUTPUT_LENGTH - (health ? health.length + 2 : 0);
  const withHealth = (result: string) => (health ? `${health}\n\n${result}` : result);

  const tools = currentDefinitions
    ? currentDefinitions.map((definition) =>
        definitionToSearchableTool(definition, ctx.toolRegistry),
      )
    : ctx.toolRegistry!.listToolsDetailed().filter((tool) => isVisible(tool, ctx));

  if (query.startsWith("select:")) {
    const names = query
      .slice(7)
      .split(",")
      .map((name) => name.trim());
    if (names.some((name) => !name) || names.length > MAX_RESULTS) {
      return `Error: select requires between 1 and ${MAX_RESULTS} non-empty tool names`;
    }
    if (ctx.runToolSurface) {
      const { selected, unavailable } = ctx.runToolSurface.select(names);
      return withHealth(
        [
          ...(selected.length ? [`Selected tools for this run: ${selected.join(", ")}.`] : []),
          ...unavailable.map(unavailableTool),
        ].join("\n"),
      );
    }
    // Legacy contexts can discover metadata, but have no per-run loading state to mutate.
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const metadata: string[] = [];
    const unavailable: string[] = [];
    for (const name of new Set(names)) {
      const tool = byName.get(name);
      if (tool) metadata.push(formatToolMetadata(tool));
      else
        unavailable.push(currentDefinitions ? unavailableTool(name) : `Tool "${name}" not found.`);
    }
    // Preserve every unavailable-name receipt; the bounded query limits their combined size.
    const unavailableText = unavailable.join("\n");
    const metadataBudget = resultBudget - (unavailableText ? unavailableText.length + 2 : 0);
    const metadataText = formatBoundedMetadata(metadata, metadataBudget);
    return withHealth([unavailableText, metadataText].filter(Boolean).join("\n\n"));
  }

  return withHealth(searchByKeyword(tools, query, maxResults, resultBudget));
}

function isVisible(tool: RegisteredTool, ctx: ToolContext): boolean {
  if (ctx.disabledBuiltins?.has(tool.name)) return false;
  if (ctx.allowedToolNames && !ctx.allowedToolNames.has(tool.name)) return false;
  if (ctx.planMode && !PLAN_MODE_ALLOWED_TOOLS.has(tool.name)) return false;
  if (tool.source !== "mcp") {
    if (isBuiltinBrowserTool(tool) && !ctx.browser) return false;
    const guard = ctx.toolRegistry!.getAvailabilityGuard(tool.name);
    return !guard || !ctx.toolVisibility || guard(ctx.toolVisibility);
  }
  // The registry is worker-shared; fallback discovery must retain the run's visibility gates.
  return (
    (!ctx.allowedMcpServers || ctx.allowedMcpServers.has(tool.serverName ?? "")) &&
    isRegisteredMcpToolAllowed(tool, ctx.mcpToolPolicies)
  );
}

function definitionToSearchableTool(
  definition: ToolDefinition,
  registry?: ToolRegistry,
): RegisteredTool {
  const registered = registry?.getTool(definition.name);
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    source: registered?.source ?? "builtin",
    ...(registered?.serverName ? { serverName: registered.serverName } : {}),
    ...(registered?.mcpToolName ? { mcpToolName: registered.mcpToolName } : {}),
    permissionDefault: registered?.permissionDefault ?? "ask",
  };
}

function unavailableTool(name: string): string {
  return `Tool "${name}" is not available in the current Session context. Do not retry unless the Session context changes.`;
}

function searchByKeyword(
  tools: RegisteredTool[],
  query: string,
  maxResults: number,
  resultBudget: number,
): string {
  const queryLower = query.toLowerCase();
  const keywords = queryLower.split(/\s+/);
  const matches = tools
    .map((tool) => {
      let score = browserDiscoveryScore(tool, query);
      const nameLower = tool.name.toLowerCase();
      const descriptionLower = tool.description.toLowerCase();
      for (const keyword of keywords) {
        if (nameLower.includes(keyword)) score += 10;
        if (descriptionLower.includes(keyword)) score += 3;
      }
      if (nameLower === queryLower) score += 50;
      return { tool, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);

  if (!matches.length) return `No tools matching "${query}".`;
  return formatBoundedMetadata(
    matches.map(({ tool }) => formatToolMetadata(tool)),
    resultBudget,
  );
}

function formatToolMetadata(tool: RegisteredTool): string {
  const description = tool.description.replace(/\s+/g, " ").trim();
  const purpose = truncateText(description, MAX_PURPOSE_LENGTH);
  const server = tool.serverName
    ? truncateText(tool.serverName.replace(/\s+/g, " ").trim(), MAX_SERVER_DISPLAY_LENGTH)
    : "";
  return (
    `### ${tool.name}\n` +
    `Source: ${tool.source}${server ? ` (${server})` : ""}\n` +
    `Purpose: ${purpose}\n` +
    `schemaRef: select:${tool.name}`
  );
}

/** Keep complete names and selection references, omitting entries that cannot fit. */
function formatBoundedMetadata(entries: string[], budget: number): string {
  const result: string[] = [];
  let length = 0;
  let omitted = false;
  const entryBudget = budget - OMITTED_METADATA_NOTICE.length - METADATA_SEPARATOR.length;
  for (const entry of entries) {
    const addition = entry.length + (result.length ? METADATA_SEPARATOR.length : 0);
    if (length + addition > entryBudget) {
      omitted = true;
      continue;
    }
    result.push(entry);
    length += addition;
  }
  if (omitted) result.push(OMITTED_METADATA_NOTICE);
  return result.join(METADATA_SEPARATOR);
}

function truncateText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

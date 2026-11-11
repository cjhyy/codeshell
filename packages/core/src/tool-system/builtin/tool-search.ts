/** Built-in ToolSearch — append eligible schemas without rewriting the tool prefix. */

import type { ContentBlock, ToolDefinition, RegisteredTool } from "../../types.js";
import {
  toolDiscoverySchemaBlock,
  toolDiscoverySchemaText,
} from "../../utils/tool-schema-discovery.js";
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
const MAX_SELECT_OUTPUT_LENGTH = 24_000;
const MAX_HEALTH_LENGTH = 2048;
const METADATA_SEPARATOR = "\n\n---\n\n";
const OMITTED_METADATA_NOTICE =
  "Some matching tools were omitted because their metadata exceeds the output budget.";

export const toolSearchToolDef: ToolDefinition = {
  name: "ToolSearch",
  description:
    "Find tools available in the current Session context by name or keyword. " +
    "Keyword searches return compact metadata and schemaRef values. " +
    'Use "select:ToolName" (or comma-separated names) to return full schemas here. ' +
    "Use CallTool when available; otherwise invoke the exact tool name with schema-matching arguments. " +
    "If an exact tool is reported unavailable, " +
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
): Promise<string | { result: string; contentBlocks: ContentBlock[] }> {
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
    const selected = formatSelectedDefinitions(
      tools,
      [...new Set(names)],
      MAX_SELECT_OUTPUT_LENGTH - (health ? health.length + 2 : 0),
      !!currentDefinitions,
      ctx.runToolSurface?.toolDiscovery === "tool-reference"
        ? NATIVE_TOOL_USAGE
        : ctx.runToolSurface
          ? CALL_TOOL_USAGE
          : DIRECT_TOOL_USAGE,
    );
    // A schema that did not fit must never become callable as a discovery side effect.
    ctx.runToolSurface?.select(selected.loaded);
    if (ctx.runToolSurface?.toolDiscovery === "tool-reference" && selected.loaded.length) {
      return {
        result: withHealth(selected.output),
        contentBlocks: [
          ...(health ? [{ type: "text" as const, text: `${health}\n\n` }] : []),
          ...selected.contentBlocks,
        ],
      };
    }
    return withHealth(selected.output);
  }

  return withHealth(searchByKeyword(tools, query, maxResults, resultBudget));
}

const CALL_TOOL_USAGE =
  "Use CallTool to call these tools: name is the exact tool name and args must match inputSchema.";
const DIRECT_TOOL_USAGE = "Call each tool by its exact name with arguments matching inputSchema.";
const NATIVE_TOOL_USAGE =
  "Call tools loaded through native references by their exact names. " +
  "For schemas shown as text, including late or changed tools, use CallTool: " +
  "name is the exact tool name and args must match inputSchema.";

function formatSelectedDefinitions(
  tools: readonly ToolDefinition[],
  names: string[],
  budget: number,
  scoped: boolean,
  usage: string,
): { output: string; loaded: string[]; contentBlocks: ContentBlock[] } {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const candidates: ToolDefinition[] = [];
  const unavailable: string[] = [];
  for (const name of names) {
    const tool = byName.get(name);
    if (tool) candidates.push(tool);
    else unavailable.push(scoped ? unavailableTool(name) : `Tool "${name}" not found.`);
  }
  const entries: string[] = [];
  const loaded: string[] = [];
  const omittedNotice = (remaining: readonly ToolDefinition[]) =>
    remaining.length
      ? `Not loaded: ${remaining.map((tool) => tool.name).join(", ")}. ` +
        "The complete schemas exceed the output budget; select each tool separately with ToolSearch select:<name>."
      : "";
  const assemble = (schemas: string[], omitted: string) =>
    [...unavailable, ...schemas, omitted, ...(schemas.length ? [usage] : [])]
      .filter(Boolean)
      .join("\n\n");
  let omitted = "";
  for (const [index, tool] of candidates.entries()) {
    const entry = toolDiscoverySchemaText(tool);
    if (assemble([...entries, entry], omittedNotice(candidates.slice(index + 1))).length > budget) {
      omitted = omittedNotice(candidates.slice(index));
      break;
    }
    entries.push(entry);
    loaded.push(tool.name);
  }
  const sections: ContentBlock[] = [
    ...unavailable.map((text) => ({ type: "text" as const, text })),
    ...loaded.map((name) => toolDiscoverySchemaBlock(byName.get(name)!)),
    ...(omitted ? [{ type: "text" as const, text: omitted }] : []),
    ...(entries.length ? [{ type: "text" as const, text: usage }] : []),
  ];
  return {
    output: assemble(entries, omitted),
    loaded,
    contentBlocks: sections.flatMap((section, index) =>
      index ? [{ type: "text" as const, text: "\n\n" }, section] : [section],
    ),
  };
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

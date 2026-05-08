/**
 * Built-in ToolSearch tool — deferred tool schema discovery.
 *
 * MCP tools are initially registered with name-only (deferred).
 * The model uses ToolSearch to discover full schemas on demand,
 * saving context by not loading all MCP tool schemas upfront.
 */

import type { ToolDefinition, RegisteredTool } from "../../types.js";
import type { ToolRegistry } from "../registry.js";
import type { ToolContext } from "../context.js";

export const toolSearchToolDef: ToolDefinition = {
  name: "ToolSearch",
  description:
    "Search for and discover available tools by name or keyword. " +
    "Some tools (especially from MCP servers) are deferred — their full schemas " +
    "are only loaded when you search for them. Use this to find the right tool.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          'Query to find tools. Use "select:ToolName" for exact match, or keywords to search.',
      },
      max_results: {
        type: "number",
        description: "Maximum results to return (default: 5)",
      },
    },
    required: ["query"],
  },
};

export async function toolSearchTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const query = args.query as string;
  if (!query) return "Error: query is required";
  if (!ctx?.toolRegistry) return "Error: ToolSearch is not configured (no registry in ctx)";

  const maxResults = Math.min((args.max_results as number) || 5, 20);

  // "select:Name1,Name2" → exact match
  if (query.startsWith("select:")) {
    const names = query.slice(7).split(",").map((n) => n.trim());
    return matchExact(ctx.toolRegistry, names);
  }

  // Keyword search
  return searchByKeyword(ctx.toolRegistry, query, maxResults);
}

function matchExact(registry: ToolRegistry, names: string[]): string {
  const results: string[] = [];
  for (const name of names) {
    const tool = registry.getTool(name);
    if (tool) {
      results.push(formatTool(tool));
    } else {
      results.push(`Tool "${name}" not found.`);
    }
  }
  return results.join("\n\n---\n\n");
}

function searchByKeyword(registry: ToolRegistry, query: string, maxResults: number): string {
  const allTools = registry.listToolsDetailed();
  const queryLower = query.toLowerCase();
  const keywords = queryLower.split(/\s+/);

  // Score each tool
  const scored = allTools.map((tool) => {
    let score = 0;
    const nameLower = tool.name.toLowerCase();
    const descLower = tool.description.toLowerCase();

    for (const kw of keywords) {
      if (nameLower.includes(kw)) score += 10;
      if (descLower.includes(kw)) score += 3;
    }

    // Exact name match bonus
    if (nameLower === queryLower) score += 50;

    return { tool, score };
  });

  const matches = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);

  if (matches.length === 0) {
    return `No tools matching "${query}". Available tools: ${allTools.map((t) => t.name).join(", ")}`;
  }

  return matches.map((m) => formatTool(m.tool)).join("\n\n---\n\n");
}

function formatTool(tool: RegisteredTool): string {
  return (
    `### ${tool.name}\n` +
    `Source: ${tool.source}${tool.serverName ? ` (${tool.serverName})` : ""}\n` +
    `${tool.description}\n` +
    `Parameters: ${JSON.stringify(tool.inputSchema, null, 2)}`
  );
}

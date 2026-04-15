/**
 * Built-in ToolSearch tool — deferred tool schema discovery.
 *
 * MCP tools are initially registered with name-only (deferred).
 * The model uses ToolSearch to discover full schemas on demand,
 * saving context by not loading all MCP tool schemas upfront.
 */

import type { ToolDefinition, RegisteredTool } from "../../types.js";
import type { ToolRegistry } from "../registry.js";

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

let _registry: ToolRegistry | undefined;

export function setToolSearchRegistry(registry: ToolRegistry): void {
  _registry = registry;
}

export async function toolSearchTool(args: Record<string, unknown>): Promise<string> {
  const query = args.query as string;
  if (!query) return "Error: query is required";
  if (!_registry) return "Error: ToolSearch is not configured";

  const maxResults = Math.min((args.max_results as number) || 5, 20);

  // "select:Name1,Name2" → exact match
  if (query.startsWith("select:")) {
    const names = query.slice(7).split(",").map((n) => n.trim());
    return matchExact(names);
  }

  // Keyword search
  return searchByKeyword(query, maxResults);
}

function matchExact(names: string[]): string {
  if (!_registry) return "Error: registry not available";

  const results: string[] = [];
  for (const name of names) {
    const tool = _registry.getTool(name);
    if (tool) {
      results.push(formatTool(tool));
    } else {
      results.push(`Tool "${name}" not found.`);
    }
  }
  return results.join("\n\n---\n\n");
}

function searchByKeyword(query: string, maxResults: number): string {
  if (!_registry) return "Error: registry not available";

  const allTools = _registry.listToolsDetailed();
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

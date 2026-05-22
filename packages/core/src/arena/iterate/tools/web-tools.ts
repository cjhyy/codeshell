/**
 * Web tools for arena iterate critics — fabrication detection support.
 *
 * Wraps the existing builtin webSearchTool / webFetchTool so critics can
 * verify factual claims during the argue phase.
 */

import type { ToolDefinition } from "../../../types.js";
import { webSearchTool } from "../../../tool-system/builtin/web-search.js";
import { webFetchTool } from "../../../tool-system/builtin/web-fetch.js";

export const webSearchToolDef: ToolDefinition = {
  name: "web_search",
  description:
    "Search the web (Google via Serper / Tavily / SearXNG depending on env). " +
    "Use this to verify any specific number, citation, URL, library version, " +
    "API name, or external claim made in the draft you are reviewing. " +
    "If a claim cannot be verified by web_search, mark it as a fabrication " +
    "critique with severity = blocker.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query (English usually works best)." },
      num_results: { type: "number", description: "Default 5, max 20." },
    },
    required: ["query"],
  },
};

export const webFetchToolDef: ToolDefinition = {
  name: "web_fetch",
  description:
    "Fetch a URL and return its text content (HTML stripped). Use after " +
    "web_search to read the actual page content of a search result and " +
    "confirm a specific claim, version number, or quoted figure.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Full http(s) URL to fetch." },
      max_length: { type: "number", description: "Default 50000 characters." },
    },
    required: ["url"],
  },
};

export const ITERATE_WEB_TOOLS: ToolDefinition[] = [webSearchToolDef, webFetchToolDef];

export async function executeIterateWebTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (toolName === "web_search") {
    return webSearchTool(args);
  }
  if (toolName === "web_fetch") {
    return webFetchTool(args);
  }
  return `Error: unknown tool "${toolName}"`;
}

/** Probe env to determine if any web-search provider is configured. */
export function hasWebSearchProvider(): boolean {
  return Boolean(
    process.env.SERPER_API_KEY ||
      process.env.TAVILY_API_KEY ||
      process.env.SEARXNG_URL,
  );
}

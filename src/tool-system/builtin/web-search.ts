/**
 * Built-in WebSearch tool — search the web via Serper, Tavily, or SearXNG.
 */

import type { ToolDefinition } from "../../types.js";

export const webSearchToolDef: ToolDefinition = {
  name: "WebSearch",
  description:
    "Search the web for information. Returns a list of search results with titles, URLs, and snippets. " +
    "Use this when you need up-to-date information or facts not in your training data.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" },
      num_results: {
        type: "number",
        description: "Number of results to return (default: 10, max: 20)",
      },
    },
    required: ["query"],
  },
};

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function webSearchTool(args: Record<string, unknown>): Promise<string> {
  const query = args.query as string;
  if (!query) return "Error: query is required";

  const numResults = Math.min((args.num_results as number) || 10, 20);

  // Try providers in order: SERPER_API_KEY → TAVILY_API_KEY → SEARXNG_URL
  const serperKey = process.env.SERPER_API_KEY;
  const tavilyKey = process.env.TAVILY_API_KEY;
  const searxngUrl = process.env.SEARXNG_URL;

  try {
    let results: SearchResult[];

    if (serperKey) {
      results = await searchSerper(query, numResults, serperKey);
    } else if (tavilyKey) {
      results = await searchTavily(query, numResults, tavilyKey);
    } else if (searxngUrl) {
      results = await searchSearXNG(query, numResults, searxngUrl);
    } else {
      return "Error: No search API configured. Set one of: SERPER_API_KEY, TAVILY_API_KEY, or SEARXNG_URL";
    }

    if (results.length === 0) return "No results found.";

    return results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join("\n\n");
  } catch (err) {
    return `Search error: ${(err as Error).message}`;
  }
}

async function searchSerper(query: string, num: number, apiKey: string): Promise<SearchResult[]> {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query, num }),
  });

  if (!res.ok) throw new Error(`Serper API error: ${res.status} ${res.statusText}`);

  const data = (await res.json()) as {
    organic?: Array<{ title?: string; link?: string; snippet?: string }>;
  };

  return (data.organic ?? []).map((item) => ({
    title: item.title ?? "",
    url: item.link ?? "",
    snippet: item.snippet ?? "",
  }));
}

async function searchTavily(query: string, num: number, apiKey: string): Promise<SearchResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: num,
      include_answer: false,
    }),
  });

  if (!res.ok) throw new Error(`Tavily API error: ${res.status} ${res.statusText}`);

  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };

  return (data.results ?? []).map((item) => ({
    title: item.title ?? "",
    url: item.url ?? "",
    snippet: item.content ?? "",
  }));
}

async function searchSearXNG(query: string, num: number, baseUrl: string): Promise<SearchResult[]> {
  const url = new URL("/search", baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageno", "1");

  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) throw new Error(`SearXNG error: ${res.status} ${res.statusText}`);

  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };

  return (data.results ?? []).slice(0, num).map((item) => ({
    title: item.title ?? "",
    url: item.url ?? "",
    snippet: item.content ?? "",
  }));
}

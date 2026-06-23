/**
 * Built-in WebSearch tool — search the web via Serper, Tavily, or SearXNG.
 *
 * Provider selection / credentials are read in this precedence:
 *   1. settings.search.{provider, apiKey, baseUrl} from ~/.code-shell/settings.json
 *      (set via the desktop "连接" UI or hand-edited)
 *   2. env vars SERPER_API_KEY / TAVILY_API_KEY / SEARXNG_URL (legacy / CI override)
 * Settings take precedence so the desktop UI's "保存连接" + "测试连接" is the
 * single source of truth for end users.
 */

import type { ToolDefinition } from "../../types.js";
import { SettingsManager } from "../../settings/manager.js";

export type SearchProvider = "serper" | "tavily" | "searxng";

export interface ResolvedSearchConfig {
  provider: SearchProvider;
  apiKey?: string;
  baseUrl?: string;
  source: "settings" | "env" | "none";
}

/**
 * Resolve the active search config. Returns `source` so callers can show
 * the user where the value came from when debugging.
 */
export function resolveSearchConfig(cwd: string = process.cwd()): ResolvedSearchConfig {
  let settingsProvider: SearchProvider | undefined;
  let settingsKey: string | undefined;
  let settingsBaseUrl: string | undefined;
  try {
    // scope "full" so the USER-level ~/.code-shell/settings.json is read, not
    // just ${cwd}/.code-shell — the search key is typically a personal/global
    // credential. Default "project" scope would miss it (the "No search provider
    // configured" bug, esp. for automation runs rooted at the app dir).
    const merged = new SettingsManager(cwd, "full").get();
    const search = (merged as { search?: Record<string, unknown> }).search ?? {};
    const p = search.provider;
    if (p === "serper" || p === "tavily" || p === "searxng") settingsProvider = p;
    // Per-provider bag takes precedence over the legacy single-slot fields
    // when the active provider matches the bag entry.
    const bag =
      search.providers && typeof search.providers === "object"
        ? (search.providers as Record<string, Record<string, unknown>>)
        : undefined;
    const bagEntry = settingsProvider && bag ? bag[settingsProvider] : undefined;
    if (bagEntry && typeof bagEntry.apiKey === "string" && bagEntry.apiKey) {
      settingsKey = bagEntry.apiKey;
    } else if (typeof search.apiKey === "string" && search.apiKey) {
      settingsKey = search.apiKey;
    }
    if (bagEntry && typeof bagEntry.baseUrl === "string" && bagEntry.baseUrl) {
      settingsBaseUrl = bagEntry.baseUrl;
    } else if (typeof search.baseUrl === "string" && search.baseUrl) {
      settingsBaseUrl = search.baseUrl;
    }
  } catch {
    /* settings unreadable — fall through to env */
  }

  const envSerper = process.env.SERPER_API_KEY;
  const envTavily = process.env.TAVILY_API_KEY;
  const envSearxng = process.env.SEARXNG_URL;

  if (settingsProvider) {
    if (settingsProvider === "searxng") {
      const base = settingsBaseUrl ?? envSearxng;
      return base
        ? { provider: "searxng", baseUrl: base, source: settingsBaseUrl ? "settings" : "env" }
        : { provider: "searxng", source: "none" };
    }
    const key =
      settingsKey ?? (settingsProvider === "serper" ? envSerper : envTavily);
    return key
      ? { provider: settingsProvider, apiKey: key, source: settingsKey ? "settings" : "env" }
      : { provider: settingsProvider, source: "none" };
  }

  if (envSerper) return { provider: "serper", apiKey: envSerper, source: "env" };
  if (envTavily) return { provider: "tavily", apiKey: envTavily, source: "env" };
  if (envSearxng) return { provider: "searxng", baseUrl: envSearxng, source: "env" };

  return { provider: "serper", source: "none" };
}

/**
 * Tool-visibility guard: WebSearch is only useful when a search provider is
 * configured. Mirrors the runtime check in the tool itself (source === "none"
 * means no provider).
 *
 * Cached per-cwd with a short TTL: this runs on EVERY message's toolDefs
 * assembly (engine.ts), and resolveSearchConfig reads + parses settings from
 * disk each call. The 1s TTL collapses back-to-back reads while still picking
 * up a newly-configured provider before the user's next message. The execution
 * path (resolveSearchConfig) is intentionally NOT cached — only this boolean.
 */
const availCache = new Map<string, { at: number; value: boolean }>();
const AVAIL_TTL_MS = 1000;

export function isWebSearchAvailable(
  cwd: string = process.cwd(),
  nowMs: number = Date.now(),
): boolean {
  const hit = availCache.get(cwd);
  if (hit && nowMs - hit.at < AVAIL_TTL_MS) return hit.value;
  let value = false;
  try {
    value = resolveSearchConfig(cwd).source !== "none";
  } catch {
    value = false; // unresolved config → treat as unavailable
  }
  availCache.set(cwd, { at: nowMs, value });
  return value;
}

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

export async function webSearchTool(
  args: Record<string, unknown>,
  ctx?: { cwd?: string },
): Promise<string> {
  const query = args.query as string;
  if (!query) return "Error: query is required";

  // Floor to default on non-positive: a negative num_results would reach
  // `results.slice(0, num)` with a negative end (= all but the last N), silently
  // returning the wrong result set. `|| 10` only caught 0/NaN, not negatives.
  const rawNum = args.num_results as number;
  const numResults = Math.min(typeof rawNum === "number" && rawNum > 0 ? rawNum : 10, 20);
  // Use the run's cwd (e.g. an automation job's project dir) so per-project
  // settings resolve correctly; falls back to process.cwd() when absent.
  const config = resolveSearchConfig(ctx?.cwd);

  if (config.source === "none") {
    return "Error: No search provider configured. Open desktop 设置 → 连接 to add credentials, or set SERPER_API_KEY / TAVILY_API_KEY / SEARXNG_URL.";
  }

  // A search provider's fetch had NO timeout and NO abort wiring — a hung/slow
  // provider blocked the tool indefinitely and a user Stop couldn't cancel it.
  // Give every provider call a 20s timeout, combined with the run's abort
  // signal (registry injects __signal) so Stop is prompt.
  const userSignal = args.__signal as AbortSignal | undefined;
  const timeoutSignal = AbortSignal.timeout(20_000);
  const signal = userSignal ? AbortSignal.any([userSignal, timeoutSignal]) : timeoutSignal;

  try {
    let results: SearchResult[];
    if (config.provider === "serper" && config.apiKey) {
      results = await searchSerper(query, numResults, config.apiKey, signal);
    } else if (config.provider === "tavily" && config.apiKey) {
      results = await searchTavily(query, numResults, config.apiKey, signal);
    } else if (config.provider === "searxng" && config.baseUrl) {
      results = await searchSearXNG(query, numResults, config.baseUrl, signal);
    } else {
      return `Error: provider "${config.provider}" missing ${config.provider === "searxng" ? "base URL" : "API key"}`;
    }

    if (results.length === 0) return "No results found.";

    return results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join("\n\n");
  } catch (err) {
    return `Search error: ${(err as Error).message}`;
  }
}

async function searchSerper(query: string, num: number, apiKey: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query, num }),
    signal,
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

async function searchTavily(query: string, num: number, apiKey: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: num,
      include_answer: false,
    }),
    signal,
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

async function searchSearXNG(query: string, num: number, baseUrl: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = new URL("/search", baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageno", "1");

  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    signal,
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

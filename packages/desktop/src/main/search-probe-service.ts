/**
 * Search provider probe — verifies that a Serper / Tavily / SearXNG
 * credential set actually returns results, so the desktop "连接" UI can
 * say more than "saved" after the user clicks 保存. Runs a minimal
 * lightweight query (`query="codeshell"`) with a short timeout.
 */

export interface SearchProbeInput {
  provider: "serper" | "tavily" | "searxng";
  apiKey?: string;
  baseUrl?: string;
}

export interface SearchProbeResult {
  status: "ok" | "error" | "unconfigured";
  /** First few result titles when status="ok" — used for the UI preview. */
  sampleTitles?: string[];
  errorMessage?: string;
  errorDetail?: string;
  lastProbedAt: string;
}

const PROBE_TIMEOUT_MS = 8_000;
const PROBE_QUERY = "codeshell";

function humanize(raw: string): string {
  if (/401|403|unauthorized|invalid key/i.test(raw))
    return "鉴权失败（API key 无效或额度耗尽）";
  if (/ETIMEDOUT|timed out/i.test(raw)) return "请求超时";
  if (/ENOTFOUND/.test(raw)) return "域名解析失败";
  if (/ECONNREFUSED/.test(raw)) return "拒绝连接（确认 Base URL）";
  if (/Invalid URL/i.test(raw)) return "Base URL 格式无效";
  return raw.split("\n")[0].slice(0, 200);
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<T>([
      p,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function probeSerper(apiKey: string): Promise<string[]> {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q: PROBE_QUERY, num: 3 }),
  });
  if (!res.ok) throw new Error(`Serper ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { organic?: Array<{ title?: string }> };
  return (data.organic ?? []).map((r) => r.title ?? "").filter(Boolean).slice(0, 3);
}

async function probeTavily(apiKey: string): Promise<string[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query: PROBE_QUERY, max_results: 3, include_answer: false }),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { results?: Array<{ title?: string }> };
  return (data.results ?? []).map((r) => r.title ?? "").filter(Boolean).slice(0, 3);
}

async function probeSearxng(baseUrl: string): Promise<string[]> {
  const url = new URL("/search", baseUrl);
  url.searchParams.set("q", PROBE_QUERY);
  url.searchParams.set("format", "json");
  const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`SearXNG ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { results?: Array<{ title?: string }> };
  return (data.results ?? []).map((r) => r.title ?? "").filter(Boolean).slice(0, 3);
}

export async function probeSearch(input: SearchProbeInput): Promise<SearchProbeResult> {
  const lastProbedAt = new Date().toISOString();

  if (input.provider === "searxng") {
    if (!input.baseUrl) return { status: "unconfigured", lastProbedAt };
  } else {
    if (!input.apiKey) return { status: "unconfigured", lastProbedAt };
  }

  try {
    let titles: string[];
    if (input.provider === "serper") {
      titles = await withTimeout(probeSerper(input.apiKey!), PROBE_TIMEOUT_MS, "Serper probe");
    } else if (input.provider === "tavily") {
      titles = await withTimeout(probeTavily(input.apiKey!), PROBE_TIMEOUT_MS, "Tavily probe");
    } else {
      titles = await withTimeout(probeSearxng(input.baseUrl!), PROBE_TIMEOUT_MS, "SearXNG probe");
    }
    return {
      status: "ok",
      sampleTitles: titles,
      lastProbedAt: new Date().toISOString(),
    };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      errorMessage: humanize(raw),
      errorDetail: err instanceof Error ? err.stack ?? raw : raw,
      lastProbedAt: new Date().toISOString(),
    };
  }
}

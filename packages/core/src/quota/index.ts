/**
 * Query remaining quota for the external coding-agent CLIs.
 *
 * Both lookups are verified against the real backends (2026-07-01):
 *   - Codex: GET https://chatgpt.com/backend-api/wham/usage → JSON
 *            rate_limit.{primary_window,secondary_window}.{used_percent,reset_at}.
 *            Zero cost (no message sent).
 *   - Claude: POST /v1/messages (max_tokens:1) → response headers
 *            anthropic-ratelimit-unified-{5h,7d}-{utilization,reset}.
 *            Costs ~1 output token (Claude exposes quota only via response
 *            headers — there is no standalone usage endpoint).
 *
 * The `fetch` and credentials are injected so this is unit-testable offline and
 * so the host owns secret resolution (see types.ts boundary note).
 */
import type {
  ProviderQuota,
  QuotaCredentials,
  QuotaResult,
  QuotaWindow,
} from "./types.js";

type FetchLike = typeof fetch;

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CLAUDE_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
/** Cheapest always-available model for the 1-token probe. */
const CLAUDE_PROBE_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_TIMEOUT_MS = 8000;

export interface CheckQuotaOptions {
  creds: QuotaCredentials;
  /** Restrict to specific providers; defaults to both. */
  providers?: ("claude" | "codex")[];
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Caller's abort signal (user Stop); composed with an internal timeout. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Compose the caller signal with a timeout so a hung backend can't block. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Codex: GET the usage endpoint and map its JSON to ProviderQuota. */
export async function queryCodexQuota(
  creds: QuotaCredentials,
  fetchImpl: FetchLike,
  signal: AbortSignal,
): Promise<ProviderQuota> {
  if (!creds.codexAccessToken) {
    return { provider: "codex", error: "no Codex token (是否已 codex login?)" };
  }
  let resp: Response;
  try {
    resp = await fetchImpl(CODEX_USAGE_URL, {
      method: "GET",
      headers: {
        authorization: `Bearer ${creds.codexAccessToken}`,
        ...(creds.codexAccountId ? { "chatgpt-account-id": creds.codexAccountId } : {}),
        originator: "codex_cli_rs",
        "user-agent": "codex_cli_rs",
      },
      signal,
    });
  } catch (err) {
    return { provider: "codex", error: `请求失败: ${(err as Error).message}` };
  }
  if (!resp.ok) {
    return { provider: "codex", error: `HTTP ${resp.status}${resp.status === 401 ? " (token 可能已过期)" : ""}` };
  }
  let body: Record<string, unknown>;
  try {
    body = (await resp.json()) as Record<string, unknown>;
  } catch {
    return { provider: "codex", error: "响应非 JSON" };
  }
  const rl = (body.rate_limit ?? {}) as Record<string, unknown>;
  const windows: QuotaWindow[] = [];
  const map: [string, "5h" | "7d"][] = [
    ["primary_window", "5h"],
    ["secondary_window", "7d"],
  ];
  for (const [key, kind] of map) {
    const w = rl[key] as Record<string, unknown> | undefined;
    if (!w) continue;
    const usedPercent = num(w.used_percent);
    if (usedPercent == null) continue;
    windows.push({ kind, usedPercent, resetsAt: num(w.reset_at) });
  }
  if (windows.length === 0) return { provider: "codex", error: "响应无 rate_limit 窗口" };
  return {
    provider: "codex",
    windows,
    planType: typeof body.plan_type === "string" ? body.plan_type : null,
  };
}

/** Claude: POST a 1-token probe and read the unified rate-limit headers. */
export async function queryClaudeQuota(
  creds: QuotaCredentials,
  fetchImpl: FetchLike,
  signal: AbortSignal,
): Promise<ProviderQuota> {
  if (!creds.claudeAccessToken) {
    return { provider: "claude", error: "no Claude Code token (是否已登录 Claude Code?)" };
  }
  let resp: Response;
  try {
    resp = await fetchImpl(CLAUDE_MESSAGES_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${creds.claudeAccessToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: CLAUDE_PROBE_MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal,
    });
  } catch (err) {
    return { provider: "claude", error: `请求失败: ${(err as Error).message}` };
  }
  if (!resp.ok) {
    return { provider: "claude", error: `HTTP ${resp.status}${resp.status === 401 ? " (token 可能已过期)" : ""}` };
  }
  const h = resp.headers;
  const windows: QuotaWindow[] = [];
  const map: [string, string, "5h" | "7d"][] = [
    ["anthropic-ratelimit-unified-5h-utilization", "anthropic-ratelimit-unified-5h-reset", "5h"],
    ["anthropic-ratelimit-unified-7d-utilization", "anthropic-ratelimit-unified-7d-reset", "7d"],
  ];
  for (const [utilKey, resetKey, kind] of map) {
    const util = num(h.get(utilKey)); // 0–1
    if (util == null) continue;
    windows.push({ kind, usedPercent: util * 100, resetsAt: num(h.get(resetKey)) });
  }
  if (windows.length === 0) return { provider: "claude", error: "响应头无 rate-limit 字段" };
  return { provider: "claude", windows };
}

/** Query both providers (or the subset requested), concurrently. */
export async function checkQuota(opts: CheckQuotaOptions): Promise<QuotaResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const providers = opts.providers ?? ["claude", "codex"];
  const signal = withTimeout(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const result: QuotaResult = {};
  await Promise.all(
    providers.map(async (p) => {
      if (p === "codex") result.codex = await queryCodexQuota(opts.creds, fetchImpl, signal);
      else result.claude = await queryClaudeQuota(opts.creds, fetchImpl, signal);
    }),
  );
  return result;
}

/** Render a QuotaResult as a compact human/agent-readable summary. */
export function formatQuota(result: QuotaResult, nowSec: number): string {
  const lines: string[] = [];
  for (const pq of [result.claude, result.codex]) {
    if (!pq) continue;
    const name = pq.provider === "claude" ? "Claude Code" : "Codex";
    if (pq.error || !pq.windows) {
      lines.push(`${name}: 查询失败 — ${pq.error ?? "unknown"}`);
      continue;
    }
    const plan = pq.planType ? ` [${pq.planType}]` : "";
    const parts = pq.windows.map((w) => {
      const reset = w.resetsAt != null ? ` (重置 ${formatReset(w.resetsAt - nowSec)})` : "";
      return `${w.kind} 用了 ${w.usedPercent.toFixed(0)}%${reset}`;
    });
    lines.push(`${name}${plan}: ${parts.join("，")}`);
  }
  return lines.length ? lines.join("\n") : "(无可用额度信息)";
}

/** "2h13m" / "45m" / "已重置" from a seconds delta. */
function formatReset(deltaSec: number): string {
  if (deltaSec <= 0) return "已重置";
  const h = Math.floor(deltaSec / 3600);
  const m = Math.floor((deltaSec % 3600) / 60);
  return h > 0 ? `${h}h${m}m 后` : `${m}m 后`;
}

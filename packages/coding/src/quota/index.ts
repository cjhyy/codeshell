/**
 * Coding capability quota for external coding-agent CLIs.
 *
 * Both lookups are verified against the real backends (2026-07-01):
 *   - Codex: GET https://chatgpt.com/backend-api/wham/usage → JSON
 *            rate_limit.{primary_window,secondary_window}.{used_percent,reset_at}.
 *            Zero cost (no message sent).
 *   - Claude: POST /v1/messages (max_tokens:1) → response headers
 *            anthropic-ratelimit-unified-<window>-{utilization,reset}, where
 *            <window> is discovered from the headers (5h / 7d / overage / …)
 *            rather than assumed — see parseClaudeWindows (re-verified
 *            2026-09-06). Costs ~1 output token (Claude exposes quota only via
 *            response headers — there is no standalone usage endpoint).
 *
 * The `fetch` and credentials are injected so this is unit-testable offline and
 * so the host owns secret resolution (see types.ts boundary note).
 */
import type { ProviderQuota, QuotaCredentials, QuotaResult, QuotaWindow } from "./types.js";

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
    return {
      provider: "codex",
      error: `HTTP ${resp.status}${resp.status === 401 ? " (token 可能已过期)" : ""}`,
    };
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
    return {
      provider: "claude",
      error: `HTTP ${resp.status}${resp.status === 401 ? " (token 可能已过期)" : ""}`,
    };
  }
  const windows = parseClaudeWindows(resp.headers);
  if (windows.length === 0) return { provider: "claude", error: "响应头无 rate-limit 字段" };
  return { provider: "claude", windows };
}

const UNIFIED_PREFIX = "anthropic-ratelimit-unified-";

/**
 * Map `representative-claim` values onto the window names used in the headers.
 * The claim spells a window out ("five_hour"); the window headers abbreviate it
 * ("5h"). An unlisted claim value falls through to an exact `kind` match, which
 * is how "overage" already lines up.
 */
const CLAIM_TO_KIND: Record<string, string> = {
  five_hour: "5h",
  seven_day: "7d",
  seven_day_sonnet: "7d_sonnet",
};

/**
 * Discover every rate-limit window from the unified headers.
 *
 * Windows are found by PREFIX, not from a hardcoded list, because which ones
 * the API sends depends on the account. A normal subscription reports 5h + 7d;
 * an account on overage reports `overage` and omits 5h/7d entirely. Matching a
 * fixed list is what silently broke this lookup before (see types.ts).
 *
 * Each window contributes `<prefix><name>-utilization` (0–1) and an optional
 * `<prefix><name>-reset` (epoch seconds). Bare `<prefix>reset` / `<prefix>status`
 * are envelope fields, not windows, so anything without a `-utilization` suffix
 * is skipped.
 */
export function parseClaudeWindows(h: Headers): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  for (const [rawKey, rawVal] of h.entries()) {
    const key = rawKey.toLowerCase();
    if (!key.startsWith(UNIFIED_PREFIX) || !key.endsWith("-utilization")) continue;
    const kind = key.slice(UNIFIED_PREFIX.length, -"-utilization".length);
    if (!kind) continue; // guard a bare `<prefix>utilization`
    const util = num(rawVal); // 0–1
    if (util == null) continue;
    windows.push({
      // Round to 4dp: `0.07 * 100` is 7.000000000000001 in binary float, which
      // leaks into equality checks and any raw (unformatted) display.
      kind,
      usedPercent: Math.round(util * 100 * 1e4) / 1e4,
      resetsAt: num(h.get(`${UNIFIED_PREFIX}${kind}-reset`)),
    });
  }
  // Stable order so output does not shuffle between identical probes.
  windows.sort((a, b) => a.kind.localeCompare(b.kind));

  // Flag the binding window. A request is throttled on this one, so it is what
  // an orchestrator should plan against when windows disagree.
  const claim = h.get(`${UNIFIED_PREFIX}representative-claim`)?.trim().toLowerCase();
  if (claim) {
    const want = CLAIM_TO_KIND[claim] ?? claim;
    const hit = windows.find((w) => w.kind === want);
    if (hit) hit.representative = true;
  }
  return windows;
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
      // Star the binding window so a reader/agent knows which one throttles.
      const star = w.representative ? "*" : "";
      return `${w.kind}${star} 用了 ${w.usedPercent.toFixed(0)}%${reset}`;
    });
    lines.push(`${name}${plan}: ${parts.join("，")}`);
  }
  return lines.length ? lines.join("\n") : "(无可用额度信息)";
}

/**
 * "3d2h" / "2h13m" / "45m" / "已重置" from a seconds delta.
 *
 * The day unit matters: this only ever had to render 5h/7d windows, but an
 * overage window can reset weeks out, and "606h0m 后" is not a readable way to
 * say 25 days.
 */
function formatReset(deltaSec: number): string {
  if (deltaSec <= 0) return "已重置";
  const d = Math.floor(deltaSec / 86400);
  const h = Math.floor((deltaSec % 86400) / 3600);
  const m = Math.floor((deltaSec % 3600) / 60);
  if (d > 0) return `${d}d${h}h 后`;
  return h > 0 ? `${h}h${m}m 后` : `${m}m 后`;
}

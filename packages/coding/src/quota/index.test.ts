import { describe, it, expect } from "bun:test";
import { checkQuota, queryClaudeQuota, queryCodexQuota, formatQuota } from "./index.js";
import type { QuotaCredentials } from "./types.js";

const NEVER_ABORT = new AbortController().signal;
const CREDS: QuotaCredentials = {
  claudeAccessToken: "cc-tok",
  codexAccessToken: "cx-tok",
  codexAccountId: "acc-1",
};

/** Real shape from chatgpt.com/backend-api/wham/usage (verified 2026-07-01). */
function codexResponse(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () =>
    ({ ok, status, json: async () => body }) as unknown as Response) as unknown as typeof fetch;
}

/** Claude returns quota only via headers on /v1/messages. */
function claudeResponse(headers: Record<string, string>, ok = true, status = 200): typeof fetch {
  const h = new Headers(headers);
  return (async () =>
    ({ ok, status, headers: h }) as unknown as Response) as unknown as typeof fetch;
}

describe("queryCodexQuota", () => {
  it("maps primary/secondary windows to 5h/7d", async () => {
    const fetchImpl = codexResponse({
      plan_type: "team",
      rate_limit: {
        primary_window: { used_percent: 21, reset_at: 1782893448 },
        secondary_window: { used_percent: 36, reset_at: 1783389389 },
      },
    });
    const q = await queryCodexQuota(CREDS, fetchImpl, NEVER_ABORT);
    expect(q.error).toBeUndefined();
    expect(q.planType).toBe("team");
    expect(q.windows).toEqual([
      { kind: "5h", usedPercent: 21, resetsAt: 1782893448 },
      { kind: "7d", usedPercent: 36, resetsAt: 1783389389 },
    ]);
  });

  it("no token → error, no fetch", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return {} as Response;
    }) as unknown as typeof fetch;
    const q = await queryCodexQuota({}, fetchImpl, NEVER_ABORT);
    expect(q.error).toContain("no Codex token");
    expect(called).toBe(false);
  });

  it("401 → surfaces expired-token hint", async () => {
    const q = await queryCodexQuota(CREDS, codexResponse({}, false, 401), NEVER_ABORT);
    expect(q.error).toContain("401");
    expect(q.error).toContain("过期");
  });

  it("missing windows → error", async () => {
    const q = await queryCodexQuota(CREDS, codexResponse({ rate_limit: {} }), NEVER_ABORT);
    expect(q.error).toContain("无 rate_limit 窗口");
  });
});

describe("queryClaudeQuota", () => {
  it("reads unified headers, converts 0–1 utilization to percent", async () => {
    const fetchImpl = claudeResponse({
      "anthropic-ratelimit-unified-5h-utilization": "0.13",
      "anthropic-ratelimit-unified-5h-reset": "1782906000",
      "anthropic-ratelimit-unified-7d-utilization": "0.04",
      "anthropic-ratelimit-unified-7d-reset": "1783483200",
    });
    const q = await queryClaudeQuota(CREDS, fetchImpl, NEVER_ABORT);
    expect(q.error).toBeUndefined();
    expect(q.windows).toEqual([
      { kind: "5h", usedPercent: 13, resetsAt: 1782906000 },
      { kind: "7d", usedPercent: 4, resetsAt: 1783483200 },
    ]);
  });

  it("no token → error, no probe sent", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return {} as Response;
    }) as unknown as typeof fetch;
    const q = await queryClaudeQuota({}, fetchImpl, NEVER_ABORT);
    expect(q.error).toContain("no Claude Code token");
    expect(called).toBe(false);
  });

  it("headers absent → error", async () => {
    const q = await queryClaudeQuota(CREDS, claudeResponse({}), NEVER_ABORT);
    expect(q.error).toContain("无 rate-limit 字段");
  });
});

describe("coding checkQuota", () => {
  it("queries only the requested provider", async () => {
    const fetchImpl = codexResponse({
      rate_limit: { primary_window: { used_percent: 5, reset_at: 1 } },
    });
    const r = await checkQuota({ creds: CREDS, providers: ["codex"], fetchImpl });
    expect(r.codex?.windows?.[0].usedPercent).toBe(5);
    expect(r.claude).toBeUndefined();
  });
});

describe("formatQuota", () => {
  const now = 1782893448 - 3600; // 1h before a reset
  it("renders percent + relative reset", () => {
    const out = formatQuota(
      {
        codex: {
          provider: "codex",
          planType: "team",
          windows: [{ kind: "5h", usedPercent: 21, resetsAt: 1782893448 }],
        },
      },
      now,
    );
    expect(out).toContain("Codex [team]");
    expect(out).toContain("5h 用了 21%");
    expect(out).toContain("1h0m 后");
  });

  it("renders failures", () => {
    const out = formatQuota({ claude: { provider: "claude", error: "boom" } }, now);
    expect(out).toContain("Claude Code: 查询失败 — boom");
  });
});

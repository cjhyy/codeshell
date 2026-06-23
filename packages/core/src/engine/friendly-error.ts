/**
 * Map a raw error into a user-friendly message with a concrete next step
 * (TODO 3.4). The turn loop emits `{type:"error", error}` to the UI; routing
 * the message through here turns opaque provider strings ("401", "ETIMEDOUT")
 * into something a user can act on. Pure + testable — no I/O.
 *
 * Heuristic, message-pattern based: we don't have typed error codes from every
 * provider, so we match on substrings. Unknown errors pass through unchanged
 * (with no suggestion) rather than getting a misleading canned message.
 */

export interface FriendlyError {
  message: string;
  /** A concrete next step, or undefined when we have nothing useful to add. */
  suggestion?: string;
}

interface Rule {
  test: RegExp;
  message?: (raw: string) => string;
  suggestion: string;
}

const RULES: Rule[] = [
  {
    test: /\b(401|403|invalid api key|unauthorized|authentication)\b/i,
    message: () => "Authentication failed — the API key was rejected.",
    suggestion:
      "Check the provider's apiKey/authCommand in settings (run /login to reconfigure), then retry.",
  },
  {
    test: /\b(429|rate.?limit|too many requests)\b/i,
    message: () => "Rate limited by the provider.",
    suggestion:
      "Wait a moment and retry, lower request frequency, or switch to a model with more headroom.",
  },
  {
    test: /\b(timed? ?out|etimedout|esockettimedout|deadline)\b/i,
    suggestion:
      "The request timed out — check your network, then retry. Long tasks can run in the background (run_in_background).",
  },
  {
    test: /\b(econnrefused|enotfound|econnreset|network|fetch failed|socket hang up)\b/i,
    message: () => "Network error reaching the provider.",
    suggestion:
      "Check your connection and the provider baseUrl, then retry. Transient errors are retried automatically.",
  },
  {
    test: /\bcontext (limit|length|window)|too long|maximum context|prompt is too long\b/i,
    message: () => "The conversation exceeded the model's context window.",
    suggestion:
      "Start a new session, /compact the history, or switch to a model with a larger context window.",
  },
  {
    test: /\b(insufficient_quota|quota|billing|payment|credit)\b/i,
    message: () => "The provider rejected the request for billing/quota reasons.",
    suggestion: "Check the provider account's quota/billing, then retry.",
  },
  {
    test: /\b(500|502|503|504|overloaded|server error|service unavailable)\b/i,
    message: () => "The provider had a server-side error.",
    suggestion:
      "This is usually transient — retry shortly, or switch models if it persists.",
  },
];

export function friendlyError(err: unknown): FriendlyError {
  const raw =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
  for (const rule of RULES) {
    if (rule.test.test(raw)) {
      return {
        message: rule.message ? rule.message(raw) : raw,
        suggestion: rule.suggestion,
      };
    }
  }
  return { message: raw };
}

/** One-line form: "<message> (<suggestion>)" — what the UI shows. */
export function formatFriendlyError(err: unknown): string {
  const f = friendlyError(err);
  return f.suggestion ? `${f.message}\n→ ${f.suggestion}` : f.message;
}

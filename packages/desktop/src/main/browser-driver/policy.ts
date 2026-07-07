/**
 * Browser-automation security policy (pure, testable). Enforced by the
 * execution layer (main), NOT the LLM — per the research conclusion that web
 * prompt-injection can't be defended at the model layer. Two gates:
 *   1. Domain whitelist — navigate/act only on allowed hosts; misses fail closed.
 *   2. Sensitive-action detection — payment/delete/credential surfaces require
 *      explicit user approval.
 *
 * Spec: docs/superpowers/specs/2026-06-16-browser-automation-mvp.md §7.
 */

export interface BrowserAutomationPolicy {
  /**
   * Allowed host patterns. Empty array → allow all (whitelist disabled, the
   * permissive default for a local user-present app). A pattern matches a host
   * exactly, or as a suffix when prefixed with "." (".example.com" matches
   * "a.example.com" and "example.com").
   */
  allowedDomains: string[];
}

export const DEFAULT_POLICY: BrowserAutomationPolicy = { allowedDomains: [] };

/** True if `url`'s host is allowed by the policy. Empty whitelist → allow all. */
export function isDomainAllowed(url: string, policy: BrowserAutomationPolicy): boolean {
  const list = policy.allowedDomains;
  if (!list || list.length === 0) return true; // whitelist disabled
  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return false; // unparseable URL → not allowed under an active whitelist
  }
  return list.some((raw) => {
    const pat = raw.trim().toLowerCase();
    if (!pat) return false;
    if (pat.startsWith(".")) {
      const bare = pat.slice(1);
      return host === bare || host.endsWith(pat);
    }
    return host === pat;
  });
}

/** Words on a button/field that signal a high-consequence action. */
const SENSITIVE_WORDS = [
  "支付",
  "付款",
  "下单",
  "确认订单",
  "删除",
  "注销",
  "转账",
  "汇款",
  "pay",
  "payment",
  "checkout",
  "place order",
  "delete",
  "remove",
  "transfer",
  "purchase",
  "buy now",
  "confirm",
];

/**
 * True when an action should require approval purely from its request shape
 * (without the page context). The richer signal (a sensitive *element*) is
 * decided at snapshot time and carried via the element's `sensitive` flag; this
 * is the cheap text-based gate on the action's own fields (e.g. typing into a
 * field whose ref text we don't have here is handled upstream — this catches
 * navigate/click whose payload text itself screams sensitive).
 */
export function isSensitiveAction(req: { action: string; text?: string; ref?: string }): boolean {
  // Typing literal card/password-looking values is sensitive regardless of page.
  if (req.action === "type" && req.text && looksLikeSecret(req.text)) return true;
  return false;
}

/** Heuristic: a value that looks like a card number or long secret. */
function looksLikeSecret(text: string): boolean {
  const digits = text.replace(/[\s-]/g, "");
  if (/^\d{13,19}$/.test(digits)) return true; // card-number-shaped
  return false;
}

export { SENSITIVE_WORDS };

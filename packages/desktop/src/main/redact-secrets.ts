/**
 * Mask values of secret-bearing keys before log data is persisted. The desktop
 * logger wrote renderer-supplied data verbatim, which could leak credentials
 * into the log file (review-2026-05-30, security). Redacts by KEY name and
 * recurses through objects/arrays, leaving non-secret fields intact for
 * debugging.
 */

// Substring keywords that are unambiguous on their own.
const SECRET_SUBSTRING = /(password|passwd|secret|token|apikey|api[_-]?key|credential|bearer|authorization)/i;
// "auth" only as its own segment (auth, authToken, x-auth) — NOT "author"/
// "authors". Split the key into case/separator parts and match a whole part.
function looksSecret(key: string): boolean {
  if (SECRET_SUBSTRING.test(key)) return true;
  const parts = key
    .replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase → spaces
    .split(/[\s._\-]+/);
  return parts.some((p) => p.toLowerCase() === "auth");
}

const MASK = "[REDACTED]";

// Content-level scrub for secrets that ride inside a STRING value under a
// non-secret key name — e.g. the bridge logs a whole worker→renderer JSON-RPC
// line under `raw`, and a short UseCredential token (`{"value":"ghp_…"}`) fits
// under the 200-char preview and slips past key-name redaction (F2). These
// patterns are deliberately high-confidence so ordinary log text isn't mangled:
//   1. a "<secret-key>":"<value>" / <key>=<value> pair whose KEY looks secret
//      (token/secret/apiKey/authorization/credential/password/value)
//   2. common prefixed credential tokens (ghp_/gho_/sk-/xoxb-/AIza/Bearer …)
const SECRET_JSON_PAIR =
  /("(?:[^"]*(?:token|secret|api[_-]?key|apikey|password|passwd|credential|authorization|bearer|value)[^"]*)"\s*:\s*)"[^"]*"/gi;
const SECRET_ASSIGN =
  /\b([A-Za-z0-9_]*(?:token|secret|api[_-]?key|apikey|password|passwd|credential|authorization|bearer)[A-Za-z0-9_]*\s*[=:]\s*)("?)[^\s"',}&]+\2/gi;
const PREFIXED_TOKEN =
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat|sk|pk|rk|xoxb|xoxp|xoxa|xapp|AIza|ya29|glpat)[-_][A-Za-z0-9._-]{8,}/g;
const BEARER = /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{8,}=*/g;

function scrubString(s: string): string {
  return s
    .replace(SECRET_JSON_PAIR, (_m, keyPart: string) => `${keyPart}"${MASK}"`)
    .replace(SECRET_ASSIGN, (_m, keyPart: string) => `${keyPart}${MASK}`)
    .replace(PREFIXED_TOKEN, MASK)
    .replace(BEARER, `Bearer ${MASK}`);
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    return value.map((v) => redactValue(v, seen));
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = looksSecret(k) ? MASK : redactValue(v, seen);
    }
    return out;
  }
  // A secret can also ride inside a plain string value under a benign key
  // (e.g. `raw` holding a serialized JSON-RPC line). Scrub token shapes.
  if (typeof value === "string") return scrubString(value);
  return value;
}

export function redactSecrets(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (data === undefined) return undefined;
  return redactValue(data, new WeakSet()) as Record<string, unknown>;
}

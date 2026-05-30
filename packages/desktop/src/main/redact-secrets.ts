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
  return value;
}

export function redactSecrets(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (data === undefined) return undefined;
  return redactValue(data, new WeakSet()) as Record<string, unknown>;
}

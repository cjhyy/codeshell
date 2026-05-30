/**
 * Mask values of secret-bearing keys before log data is persisted. The desktop
 * logger wrote renderer-supplied data verbatim, which could leak credentials
 * into the log file (review-2026-05-30, security). This redacts by KEY name
 * (case-insensitive substring) and recurses through objects/arrays, leaving
 * non-secret fields intact for debugging.
 */
const SECRET_KEY = /(password|passwd|secret|token|apikey|api[_-]?key|auth|credential|bearer)/i;
const MASK = "[REDACTED]";

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? MASK : redactValue(v);
    }
    return out;
  }
  return value;
}

export function redactSecrets(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (data === undefined) return undefined;
  return redactValue(data) as Record<string, unknown>;
}

/**
 * Decode-free size estimate of a base64 string.
 *
 * Returns the count of bytes the base64 string would produce *after*
 * decoding. Used everywhere we need to "weigh" an image without paying
 * the cost of `Buffer.from(s, "base64")` allocation.
 *
 *   - 4 base64 chars → 3 decoded bytes.
 *   - Trailing `=` padding subtracts from the byte count.
 *   - Tolerates whitespace and missing padding by working off `length`
 *     modulo 4 — the wire format strips whitespace via parse-task, so
 *     this only matters when an exotic caller hands us raw textarea text.
 */
export function byteLengthFromBase64(b64: string): number {
  if (!b64) return 0;
  // Strip whitespace defensively; the parser already does this, but other
  // callers (logging stubs, MCP image blocks) might not.
  const clean = b64.replace(/\s+/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

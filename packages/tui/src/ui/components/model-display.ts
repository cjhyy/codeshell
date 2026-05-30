/**
 * Shared model-display helpers used by ModelSelector and ModelManager (they
 * had identical private copies — review-2026-05-30).
 */

/** Compact token count: 128000 → "128K", 1000000 → "1M", undefined → "?". */
export function fmtTokens(n: number | undefined): string {
  if (!n || n <= 0) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return `${n}`;
}

/** Derive capability tags from a model key/name. */
export function modelTags(key: string, model: string): string[] {
  const tags: string[] = [];
  const lower = `${key} ${model}`.toLowerCase();
  if (/coder|code|devstral/i.test(lower)) tags.push("coding");
  if (/reason|think|r1|o3|o4|pro/i.test(lower)) tags.push("reasoning");
  if (/flash|mini|haiku|fast|small|nano/i.test(lower)) tags.push("fast");
  if (/cheap|free/i.test(lower)) tags.push("cheap");
  if (/large|max|ultra|opus|big/i.test(lower)) tags.push("powerful");
  return tags;
}

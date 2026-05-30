/**
 * Extract the file target of a trailing shell redirect (`> file` / `>> file`).
 * Handles quoted paths with spaces — the old /> \s*(\S+)\s*$/ matched only the
 * first non-whitespace run, so `> "my file.txt"` yielded `"my`
 * (review-2026-05-30). Returns undefined when there's no trailing redirect.
 */
export function parseRedirectTarget(command: string): string | undefined {
  // Optional quote captured in group 1; body in group 2 (or unquoted in 3).
  const m = command.match(/>>?\s*(?:(['"])(.*?)\1|(\S+))\s*$/);
  if (!m) return undefined;
  return m[2] !== undefined ? m[2] : m[3];
}

/**
 * EOL (line-ending) helpers for file-editing tools.
 *
 * Windows files are typically CRLF (`\r\n`); the model emits LF (`\n`). The
 * file tools match the model's strings against file content and write the
 * result back. Without normalization:
 *   - an LF `old_string` never matches a CRLF file → "old_string not found";
 *   - a successful write that re-joins with LF silently converts a CRLF file
 *     to LF, so `git diff` shows the whole file changed (and an .editorconfig
 *     /prettier may flip it right back → churn).
 *
 * The contract these helpers enforce:
 *   1. Detect the file's dominant EOL.
 *   2. Compare/replace in LF space (normalize both file content and the
 *      model's needle to LF first).
 *   3. Write back in the ORIGINAL EOL so the file's line-ending style is
 *      preserved.
 */

export type Eol = "\r\n" | "\n";

/**
 * The file's dominant line ending. CRLF if the content contains ANY `\r\n`
 * (Windows editors are all-or-nothing in practice); otherwise LF. Empty/no-
 * newline content defaults to LF.
 */
export function detectEol(content: string): Eol {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/** Collapse all CRLF (and lone CR) to LF for comparison/replacement. */
export function toLf(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Re-apply an EOL to LF-normalized text. No-op for LF. */
export function applyEol(s: string, eol: Eol): string {
  if (eol === "\n") return s;
  // s is already LF-normalized by callers; map every LF back to CRLF.
  return s.replace(/\n/g, "\r\n");
}

/**
 * Mention detection — given the textarea contents and the current caret
 * offset, decide whether the caret sits inside an `@`-token. Pulled out
 * of ChatView so the rules can be unit-tested in isolation.
 *
 * Rules:
 *   - Walk back from caret-1 looking for `@`.
 *   - The `@` must be at column 0 OR preceded by whitespace (so emails
 *     like `foo@bar.com` don't trigger the popover).
 *   - Anything between the `@` and the caret must be non-whitespace.
 *   - We give up after 80 chars to keep this O(1) on huge prompts.
 *
 * Returns the start of the `@` and the query typed after it, or null.
 */
export interface MentionRange {
  start: number;
  query: string;
}

export function detectMention(text: string, caret: number): MentionRange | null {
  if (caret <= 0) return null;
  for (let i = caret - 1; i >= 0 && caret - i <= 80; i--) {
    const ch = text[i];
    if (ch === "@") {
      const before = i === 0 ? "" : text[i - 1];
      if (i !== 0 && !/\s/.test(before)) return null;
      const query = text.slice(i + 1, caret);
      if (/\s/.test(query)) return null;
      return { start: i, query };
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}

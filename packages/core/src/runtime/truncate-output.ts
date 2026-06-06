/**
 * Head+tail truncation for long command output (TODO 2.11 — shell snapshot).
 *
 * The naive "keep first N chars, drop the rest" loses the END of the output —
 * which for a failing command is usually the most important part (the error,
 * the stack tail, the final summary line). Instead, when output exceeds `cap`,
 * keep a head slice AND a tail slice with a clear marker noting how much was
 * dropped in the middle. Pure + testable.
 */

export interface TruncateOptions {
  /** Max total chars to keep before truncating (head + tail combined budget). */
  cap: number;
  /** Fraction of the kept budget given to the head (rest goes to the tail). Default 0.5. */
  headRatio?: number;
}

/**
 * Keep the head and tail of `text` when it's longer than `cap`, joined by a
 * marker that states how many chars were omitted. Returns the input unchanged
 * when it fits. Slices on line boundaries when possible so a cut doesn't land
 * mid-line (falls back to a hard char cut for a single huge line).
 */
export function truncateHeadTail(text: string, opts: TruncateOptions): string {
  const { cap } = opts;
  if (cap <= 0 || text.length <= cap) return text;

  const headRatio = opts.headRatio ?? 0.5;
  const headBudget = Math.max(0, Math.floor(cap * headRatio));
  const tailBudget = Math.max(0, cap - headBudget);

  const head = sliceHead(text, headBudget);
  const tail = sliceTail(text, tailBudget);
  const omitted = text.length - head.length - tail.length;
  if (omitted <= 0) return text; // ratios collapsed to no real cut

  return (
    head +
    `\n\n… [${omitted} chars omitted — showing first ${head.length} + last ${tail.length}] …\n\n` +
    tail
  );
}

/** Take up to `budget` chars from the start, preferring a line boundary. */
function sliceHead(text: string, budget: number): string {
  if (budget <= 0) return "";
  const raw = text.slice(0, budget);
  const lastNl = raw.lastIndexOf("\n");
  // Snap back to the last newline if it keeps at least ~60% of the budget,
  // otherwise the line is huge — hard cut to avoid throwing away most of it.
  return lastNl > budget * 0.6 ? raw.slice(0, lastNl) : raw;
}

/** Take up to `budget` chars from the end, preferring a line boundary. */
function sliceTail(text: string, budget: number): string {
  if (budget <= 0) return "";
  const raw = text.slice(text.length - budget);
  const firstNl = raw.indexOf("\n");
  return firstNl >= 0 && firstNl < budget * 0.4 ? raw.slice(firstNl + 1) : raw;
}

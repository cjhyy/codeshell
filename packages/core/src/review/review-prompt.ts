/**
 * Code-review prompt builder (TODO 7.3). Produces the instruction sent to the
 * model for `/review`. Pure + testable — the TUI/desktop command gathers the
 * diff or file contents and calls this; the model does the actual reasoning.
 *
 * Findings are structured: priority P0–P3, a confidence score, and a precise
 * location, so the output is consistent and (optionally) machine-readable for
 * CI/CD via `--json`.
 */

export type ReviewDimension =
  | "security"
  | "performance"
  | "readability"
  | "correctness";

export const ALL_DIMENSIONS: ReviewDimension[] = [
  "correctness",
  "security",
  "performance",
  "readability",
];

const DIMENSION_LABEL: Record<ReviewDimension, string> = {
  security: "安全 (injection, authz, secret leakage, unsafe deserialization)",
  performance: "性能 (N+1, needless allocation, blocking I/O, complexity)",
  readability: "可读性 (naming, structure, dead code, comment accuracy)",
  correctness: "正确性 (logic bugs, edge cases, error handling, races)",
};

export interface ReviewPromptOptions {
  /** The unified diff (incremental) or full file contents to review. */
  content: string;
  /** Which dimensions to weigh. Defaults to all four. */
  dimensions?: ReviewDimension[];
  /** True when reviewing a diff (incremental); false when reviewing whole files. */
  incremental?: boolean;
  /** Emit a machine-readable JSON findings array (for CI/CD) instead of prose. */
  json?: boolean;
  /** Optional label for what's under review (e.g. a file path). */
  label?: string;
  /** Truncate content to this many chars (default 12000). */
  maxChars?: number;
}

/** Normalize a comma/space list of dimension names; invalid names dropped. */
export function parseDimensions(input: string | undefined): ReviewDimension[] {
  if (!input) return ALL_DIMENSIONS;
  const wanted = input
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const picked = ALL_DIMENSIONS.filter((d) => wanted.includes(d));
  return picked.length > 0 ? picked : ALL_DIMENSIONS;
}

const PRIORITY_GUIDE =
  "Priority: P0 = must fix before merge (data loss, security hole, crash); " +
  "P1 = should fix (likely bug, real risk); " +
  "P2 = nice to fix (smell, minor inefficiency); " +
  "P3 = optional (style, nit).";

export function buildReviewPrompt(opts: ReviewPromptOptions): string {
  const dims = opts.dimensions?.length ? opts.dimensions : ALL_DIMENSIONS;
  const maxChars = opts.maxChars ?? 12_000;
  const body = opts.content.length > maxChars
    ? opts.content.slice(0, maxChars) + "\n…(truncated)…"
    : opts.content;
  const fence = opts.incremental === false ? "" : "diff";
  const what = opts.incremental === false ? "code" : "code changes (diff)";
  const subject = opts.label ? ` for \`${opts.label}\`` : "";

  const dimLines = dims.map((d) => `  - ${DIMENSION_LABEL[d]}`).join("\n");

  if (opts.json) {
    return [
      `Review the following ${what}${subject} across these dimensions:`,
      dimLines,
      ``,
      PRIORITY_GUIDE,
      ``,
      `Respond with ONLY a JSON object (no prose, no markdown fence) of the form:`,
      `{"summary": string, "findings": [{"priority": "P0"|"P1"|"P2"|"P3", ` +
        `"dimension": ${dims.map((d) => `"${d}"`).join("|")}, ` +
        `"confidence": number /*0..1*/, "location": string /*file:line*/, ` +
        `"title": string, "detail": string, "suggestion": string}]}`,
      `Order findings by priority then confidence. Omit a finding rather than guess.`,
      ``,
      "```" + fence,
      body,
      "```",
    ].join("\n");
  }

  return [
    `Review the following ${what}${subject} across these dimensions:`,
    dimLines,
    ``,
    PRIORITY_GUIDE,
    ``,
    `For each finding, give: **[P0-P3]** a short title, the location (file:line), ` +
      `your confidence (low/med/high), what's wrong, and a concrete fix.`,
    `Start with a one-line summary, then list findings ordered by priority. ` +
      `If nothing warrants a finding, say so plainly. Don't pad with nits to look thorough.`,
    ``,
    "```" + fence,
    body,
    "```",
  ].join("\n");
}

/**
 * Approval-card summary + risk normalization. Extracted from the old inline
 * mobile-ui (the `ks=['command','file_path',…]` scan + medium fallback) so it
 * is testable. The phone shows this on every approval.request /
 * agent/approvalRequest. Decisions still go through the core permission engine
 * (the phone never bypasses it — design §6).
 */
export type Risk = "low" | "medium" | "high";

/** Arg keys to surface as the one-line summary, in priority order. */
const SUMMARY_KEYS = [
  "command",
  "file_path",
  "path",
  "url",
  "pattern",
  "query",
] as const;

export function summarizeApproval(
  args: Record<string, unknown> | undefined,
  risk?: string,
): { summary: string; risk: Risk } {
  let summary = "";
  for (const k of SUMMARY_KEYS) {
    const v = args?.[k];
    if (typeof v === "string" && v.length > 0) {
      summary = v;
      break;
    }
  }
  if (!summary) summary = JSON.stringify(args ?? {});
  const r: Risk = risk === "low" || risk === "high" ? risk : "medium";
  return { summary, risk: r };
}

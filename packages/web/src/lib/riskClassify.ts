/**
 * Approval-card summary + risk normalization. Extracted from the old inline
 * mobile-ui (the `ks=['command','file_path',…]` scan + medium fallback) so it
 * is testable. The phone shows this on every approval.request /
 * agent/approvalRequest. Decisions still go through the core permission engine
 * (the phone never bypasses it — design §6).
 */
import { t } from "../i18n/translate.js";

export type Risk = "low" | "medium" | "high";

/** Arg keys to surface as the one-line summary, in priority order. */
const SUMMARY_KEYS = ["command", "file_path", "path", "url", "pattern", "query"] as const;

export function summarizeApproval(
  args: Record<string, unknown> | undefined,
  risk?: string,
  toolName?: string,
): { summary: string; risk: Risk } {
  let summary = "";
  // Match on the tool NAME, never on arg shape: a third-party/MCP tool whose
  // args happen to carry source/scope/resource must not masquerade as a
  // data-source read (nor shadow its real `command`/`file_path` summary).
  const source = args?.source;
  const scope = args?.scope;
  const resource = args?.resource;
  if (
    toolName === "ReadSource" &&
    typeof source === "string" &&
    source.length > 0 &&
    typeof scope === "string" &&
    scope.length > 0 &&
    typeof resource === "string" &&
    resource.length > 0
  ) {
    summary = t("mobile.approval.readSourceSummary", { source, scope, resource });
  } else {
    for (const k of SUMMARY_KEYS) {
      const v = args?.[k];
      if (typeof v === "string" && v.length > 0) {
        summary = v;
        break;
      }
    }
  }
  if (!summary) summary = JSON.stringify(args ?? {});
  // Normalize the server-supplied risk. The three known levels pass through;
  // anything else (absent → fall through to medium default; but an UNKNOWN
  // non-empty value like "critical" from a corrupted/malicious server) must NOT
  // silently downgrade to medium — fail SAFE to "high" so the badge can't
  // under-state a dangerous op and nudge an approve. The core permission engine
  // is still authoritative; this only governs the user-visible badge.
  let r: Risk;
  if (risk === "low" || risk === "medium" || risk === "high") {
    r = risk;
  } else if (risk === undefined || risk === "") {
    r = "medium"; // unspecified → the historical neutral default
  } else {
    r = "high"; // unrecognized non-empty value → fail safe (don't under-state)
  }
  return { summary, risk: r };
}

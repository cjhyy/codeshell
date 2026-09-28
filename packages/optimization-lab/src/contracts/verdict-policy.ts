/**
 * Verdict vocabulary copied from evals/harness/cases.json so lab reports and the
 * engineering harness share one contract. The drift test compares both; the
 * harness runner itself is not a product SDK and is never imported.
 */
export const VERDICT_POLICY_SUITE_VERSION = "2026-09-12.3";

export const VERDICT_POLICY = {
  criterionVerdicts: ["passed", "failed", "inconclusive", "not-applicable"],
  hardAndSemanticIndependent: true,
  hardFailureCannotBeOverriddenBySemanticScore: true,
  missingEvidenceVerdict: "inconclusive",
  executionReasons: ["completed", "cancelled", "timeout", "provider-error", "environment-error"],
  executionStatuses: ["passed", "failed", "inconclusive", "skipped"],
  semanticStatuses: ["passed", "failed", "not_evaluated", "not_applicable"],
  reportEvidenceLevels: ["packaged_live_llm", "repository_regression", "catalogue"],
  hardAssertionValue: "passed: true | false | null (unknown)",
} as const;

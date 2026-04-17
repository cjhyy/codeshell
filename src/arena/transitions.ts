/**
 * Claim state machine — centralized transition rules.
 *
 * All claim status changes go through this module to enforce
 * consistent state transitions across phases.
 *
 * State machine:
 *   proposed → under_review
 *   under_review → verified | contested | rejected
 *   contested → under_review | unresolved | verified | rejected
 */

import type { ClaimRecord, ClaimStatus, ClaimChallenge } from "./types.js";

/** Valid transitions from each status */
const VALID_TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
  proposed:     ["under_review"],
  under_review: ["verified", "contested", "rejected"],
  contested:    ["under_review", "unresolved", "verified", "rejected"],
  verified:     [],
  rejected:     [],
  unresolved:   [],
};

/**
 * Attempt to transition a claim to a new status.
 * Returns true if the transition was applied, false if invalid.
 */
export function transitionClaim(claim: ClaimRecord, to: ClaimStatus): boolean {
  const allowed = VALID_TRANSITIONS[claim.status];
  if (!allowed.includes(to)) {
    return false;
  }
  claim.status = to;
  return true;
}

/**
 * Determine the next status for a claim based on its challenges.
 *
 * Rules:
 * - Any "disagree" → contested
 * - Any "needs_evidence" → contested
 * - All "agree" (with possible "refine") and no pending checks → verified
 * - No challenges yet → stays as-is
 */
export function resolveClaimStatus(
  claim: ClaimRecord,
  challenges: ClaimChallenge[],
  hasPendingChecks: boolean,
): ClaimStatus {
  if (challenges.length === 0) return claim.status;

  const verdicts = challenges.map((c) => c.verdict);

  if (verdicts.includes("disagree") || verdicts.includes("needs_evidence")) {
    return "contested";
  }

  if (hasPendingChecks) {
    return "contested";
  }

  // All agree or refine — verified
  return "verified";
}

/**
 * Mark a claim as entering review.
 */
export function markUnderReview(claim: ClaimRecord): boolean {
  return transitionClaim(claim, "under_review");
}

/**
 * Apply review results to a claim and transition appropriately.
 */
export function applyReviewResult(
  claim: ClaimRecord,
  challenges: ClaimChallenge[],
  hasPendingChecks: boolean,
): void {
  const nextStatus = resolveClaimStatus(claim, challenges, hasPendingChecks);
  transitionClaim(claim, nextStatus);
}

/**
 * Mark a contested claim as unresolved (budget/round exhausted).
 */
export function markUnresolved(claim: ClaimRecord): boolean {
  return transitionClaim(claim, "unresolved");
}

/**
 * Check if a claim is in a terminal state (no further transitions possible).
 */
export function isTerminal(claim: ClaimRecord): boolean {
  return VALID_TRANSITIONS[claim.status].length === 0;
}

/**
 * Get valid next statuses for a claim.
 */
export function validTransitions(claim: ClaimRecord): ClaimStatus[] {
  return VALID_TRANSITIONS[claim.status];
}

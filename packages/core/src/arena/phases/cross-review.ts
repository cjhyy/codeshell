/**
 * CrossReview / VerificationReview — participants review each other's findings.
 *
 * V1 (CrossReview): Each participant sees the other participants' structured findings
 * and provides per-finding verdicts: agree, refine, disagree, needs_evidence.
 *
 * V2 (VerificationReview): Reviewers get claim + evidence packet + digest data,
 * and produce ClaimChallenge records that feed into the claim state machine.
 */

import { createLLMClient } from "../../llm/client-factory.js";
import type {
  ArenaParticipant,
  ArenaStrategy,
  ArenaStrategyPlanning,
  ParticipantReport,
  FindingReview,
  ClaimRecord,
  ClaimChallenge,
  ArenaProgressEvent,
  ArenaExecutionLimits,
} from "../types.js";
import { isStrategyV2, isStrategyPlanning } from "../types.js";
import type { ArenaLedger } from "../ledger.js";
import { selectClaimsForReview } from "./claim-registry.js";
import { buildDigest } from "../digest-builder.js";
import { markUnderReview, applyReviewResult } from "../transitions.js";
import { logger } from "../../logging/logger.js";

// ─── V1: Legacy Cross Review ──────────────────────────────────────

interface CrossReviewOptions {
  participants: ArenaParticipant[];
  strategy: ArenaStrategy;
  topic: string;
  reports: ParticipantReport[];
  signal?: AbortSignal;
  onProgress?: (event: ArenaProgressEvent) => void;
}

/**
 * Run cross-review phase (V1). Each participant reviews the others' findings.
 */
export async function runCrossReview(options: CrossReviewOptions): Promise<FindingReview[]> {
  const { participants, strategy, topic, reports, signal, onProgress } = options;

  onProgress?.({ type: "cross_review_start", round: 1 });

  const allReviews: FindingReview[] = [];

  const tasks = participants.map(async (p) => {
    const myReport = reports.find((r) => r.participant === p.name);
    const otherReports = reports.filter((r) => r.participant !== p.name);

    // Skip if no other reports to review
    if (otherReports.length === 0) return [];
    if (!myReport) return [];

    const client = await createLLMClient({
      ...p.llm,
      enableStreaming: false,
    });

    const systemPrompt = strategy.crossReviewSystemPrompt(p.name);
    const userContent = strategy.crossReviewUserPrompt(topic, myReport, otherReports);

    let response = await client.createMessage({
      systemPrompt,
      messages: [{ role: "user", content: userContent }],
      signal,
    });

    logger.info("arena.cross_review_raw_response", {
      participant: p.name,
      text: response.text,
      stopReason: response.stopReason,
    });

    // Retry if truncated
    if (response.stopReason === "length") {
      logger.warn("arena.cross_review_truncated", { participant: p.name });

      const retryResponse = await client.createMessage({
        systemPrompt,
        messages: [
          { role: "user", content: userContent },
          { role: "assistant", content: response.text },
          {
            role: "user",
            content:
              "Your previous response was truncated. Please output the COMPLETE review JSON, using shorter comments. Respond ONLY with JSON.",
          },
        ],
        signal,
      });

      logger.info("arena.cross_review_retry", {
        participant: p.name,
        stopReason: retryResponse.stopReason,
      });

      response = retryResponse;
    }

    return strategy.parseCrossReviewResponse(p.name, response.text);
  });

  const results = await Promise.all(tasks);
  for (const reviews of results) {
    allReviews.push(...reviews);
  }

  onProgress?.({ type: "cross_review_done", reviews: allReviews });
  return allReviews;
}

// ─── V2: Verification Review ──────────────────────────────────────

interface VerificationReviewOptions {
  participants: ArenaParticipant[];
  strategy: ArenaStrategy;
  topic: string;
  reports: ParticipantReport[];
  ledger: ArenaLedger;
  limits: ArenaExecutionLimits;
  /** Arena mode — planning routes to merge-oriented review */
  mode?: "review" | "discussion" | "planning";
  signal?: AbortSignal;
  onProgress?: (event: ArenaProgressEvent) => void;
}

interface VerificationReviewResult {
  reviews: FindingReview[];
  challenges: ClaimChallenge[];
}

/**
 * Run verification-review phase. Reviewers get claim + evidence + digest data.
 * Falls back to V1 cross-review if strategy doesn't implement V2.
 */
export async function runVerificationReview(
  options: VerificationReviewOptions,
): Promise<VerificationReviewResult> {
  const { participants, strategy, topic, reports, ledger, limits, mode, signal, onProgress } = options;

  // Select claims to review, prioritized by severity + confidence
  const allClaims = ledger.getAllClaims();
  const claimsToReview = selectClaimsForReview(allClaims, limits.maxClaimsForReview);

  // Transition selected claims to under_review
  for (const claim of claimsToReview) {
    markUnderReview(claim);
  }

  // Build digest for reviewer context
  const relevantClaimIds = claimsToReview.map((c) => c.claimId);
  const digest = buildDigest(ledger, { round: 1, relevantClaimIds });

  const isPlanningMerge = mode === "planning" && isStrategyPlanning(strategy);
  if (isPlanningMerge) {
    onProgress?.({ type: "planning_merge_review_start" });
  } else {
    onProgress?.({ type: "verification_start" });
  }

  const v2 = isStrategyV2(strategy);
  const allReviews: FindingReview[] = [];
  const allChallenges: ClaimChallenge[] = [];

  // Assign claims to reviewers: each claim reviewed by non-owners, capped
  const tasks = participants.map(async (p) => {
    const myReport = reports.find((r) => r.participant === p.name);
    const otherReports = reports.filter((r) => r.participant !== p.name);
    if (!myReport || otherReports.length === 0) return;

    // Claims this participant should review (not their own)
    const myClaims = claimsToReview.filter((c) => c.owner !== p.name);
    if (myClaims.length === 0) return;

    const client = await createLLMClient({
      ...p.llm,
      enableStreaming: false,
    });

    const systemPrompt = strategy.crossReviewSystemPrompt(p.name);

    if (v2) {
      // V2 path: claim-aware verification review (or merge review for planning)
      const userContent = isPlanningMerge
        ? (strategy as ArenaStrategyPlanning).mergeReviewUserPrompt(topic, myReport, myClaims, digest)
        : (strategy as import("../types.js").ArenaStrategyV2)
            .verificationReviewUserPrompt(topic, myReport, myClaims, digest);

      let response = await client.createMessage({
        systemPrompt,
        messages: [{ role: "user", content: userContent }],
        signal,
      });

      logger.info("arena.verification_review_raw", {
        participant: p.name,
        stopReason: response.stopReason,
      });

      if (response.stopReason === "length") {
        const retryResponse = await client.createMessage({
          systemPrompt,
          messages: [
            { role: "user", content: userContent },
            { role: "assistant", content: response.text },
            { role: "user", content: "Truncated. Output the COMPLETE JSON array, shorter comments. JSON only." },
          ],
          signal,
        });
        response = retryResponse;
      }

      const challenges = isPlanningMerge
        ? (strategy as ArenaStrategyPlanning).parseMergeReviewResponse(p.name, response.text)
        : (strategy as import("../types.js").ArenaStrategyV2)
            .parseVerificationReviewResponse(p.name, response.text);

      for (const challenge of challenges) {
        allChallenges.push(challenge);
        ledger.appendChallenge(challenge);
      }

      // Also produce FindingReview for backward compat
      for (const ch of challenges) {
        allReviews.push({
          reviewer: ch.reviewer,
          findingId: ch.claimId,
          verdict: ch.verdict,
          reason: ch.reason,
          extraEvidence: ch.supportingEvidenceRefs,
        });
      }
    } else {
      // V1 fallback: standard cross-review, then map to challenges
      const userContent = strategy.crossReviewUserPrompt(topic, myReport, otherReports);

      let response = await client.createMessage({
        systemPrompt,
        messages: [{ role: "user", content: userContent }],
        signal,
      });

      if (response.stopReason === "length") {
        const retryResponse = await client.createMessage({
          systemPrompt,
          messages: [
            { role: "user", content: userContent },
            { role: "assistant", content: response.text },
            { role: "user", content: "Truncated. Output COMPLETE review JSON. Shorter comments. JSON only." },
          ],
          signal,
        });
        response = retryResponse;
      }

      const reviews = strategy.parseCrossReviewResponse(p.name, response.text);
      allReviews.push(...reviews);

      // Map FindingReview → ClaimChallenge for claim state updates
      for (const review of reviews) {
        // Find the claim that matches this finding
        const claim = claimsToReview.find((c) =>
          c.finding.id === review.findingId || c.claimId === review.findingId,
        );
        if (claim) {
          const challenge: ClaimChallenge = {
            reviewer: review.reviewer,
            claimId: claim.claimId,
            verdict: review.verdict,
            reason: review.reason,
            supportingEvidenceRefs: review.extraEvidence,
          };
          allChallenges.push(challenge);
          ledger.appendChallenge(challenge);
        }
      }
    }
  });

  await Promise.all(tasks);

  // Apply review results to claim status transitions
  for (const claim of claimsToReview) {
    const claimChallenges = ledger.getChallengesForClaim(claim.claimId);
    const hasPendingChecks = ledger.getPendingChecksForClaim(claim.claimId).length > 0;
    applyReviewResult(claim, claimChallenges, hasPendingChecks);
  }

  logger.info("arena.verification_done", {
    reviewCount: allReviews.length,
    challengeCount: allChallenges.length,
    claimStatuses: Object.fromEntries(
      claimsToReview.map((c) => [c.claimId, c.status]),
    ),
  });

  if (isPlanningMerge) {
    onProgress?.({ type: "planning_merge_review_done", mergeCount: allChallenges.length });
  } else {
    onProgress?.({ type: "verification_done", challengeCount: allChallenges.length });
  }
  onProgress?.({ type: "cross_review_done", reviews: allReviews });

  return { reviews: allReviews, challenges: allChallenges };
}

/**
 * Adjudication — the moderator makes evidence-based rulings on contested claims.
 *
 * For each contested/debated claim, the moderator sees the full claim context
 * (evidence, challenges, debate rounds) and produces a ClaimAdjudication.
 *
 * Claims that were verified without contest get synthetic adjudication records.
 */

import { createLLMClient } from "../../llm/client-factory.js";
import type {
  ArenaParticipant,
  ArenaStrategy,
  ClaimRecord,
  ClaimAdjudication,
  ArenaProgressEvent,
} from "../types.js";
import { isStrategyV2 } from "../types.js";
import type { ArenaStrategyV2 } from "../types.js";
import type { ArenaLedger } from "../ledger.js";
import { buildDigest } from "../digest-builder.js";
import { transitionClaim, markUnresolved } from "../transitions.js";
import { parseAdjudication as parseAdjudicationUtil } from "../strategies/utils.js";
import { logger } from "../../logging/logger.js";

interface AdjudicationOptions {
  concluder: ArenaParticipant;
  strategy: ArenaStrategy;
  topic: string;
  ledger: ArenaLedger;
  signal?: AbortSignal;
  onProgress?: (event: ArenaProgressEvent) => void;
}

/**
 * Run adjudication phase. The moderator rules on contested claims.
 * Verified claims get synthetic adjudications.
 */
export async function runAdjudication(
  options: AdjudicationOptions,
): Promise<ClaimAdjudication[]> {
  const { concluder, strategy, topic, ledger, signal, onProgress } = options;

  const allAdjudications: ClaimAdjudication[] = [];
  const v2 = isStrategyV2(strategy);

  // Claims that need moderator adjudication: contested or those with debate rounds
  const contestedClaims = ledger.getClaimsByStatus("contested");

  // Claims that were verified cleanly — synthetic adjudication
  const verifiedClaims = ledger.getClaimsByStatus("verified");

  if (contestedClaims.length === 0 && verifiedClaims.length === 0) {
    logger.info("arena.adjudication_skip", { reason: "no claims to adjudicate" });
    return [];
  }

  logger.info("arena.adjudication_start", {
    contested: contestedClaims.length,
    verified: verifiedClaims.length,
  });

  // Adjudicate contested claims via LLM
  const client = await createLLMClient({
    ...concluder.llm,
    enableStreaming: false,
  });

  for (const claim of contestedClaims) {
    signal?.throwIfAborted();

    const digest = buildDigest(ledger, {
      round: 0, // adjudication is post-debate
      relevantClaimIds: [claim.claimId],
    });

    const systemPrompt = strategy.consensusSystemPrompt();
    let userContent: string;

    if (v2) {
      userContent = (strategy as ArenaStrategyV2)
        .adjudicationUserPrompt(topic, claim, claim.debateRounds, digest);
    } else {
      userContent = buildFallbackAdjudicationPrompt(topic, claim);
    }

    const response = await client.createMessage({
      systemPrompt,
      messages: [{ role: "user", content: userContent }],
      signal,
    });

    logger.info("arena.adjudication_response", {
      claimId: claim.claimId,
      stopReason: response.stopReason,
    });

    let adjudication: ClaimAdjudication;

    if (v2) {
      adjudication = (strategy as ArenaStrategyV2).parseAdjudicationResponse(response.text);
      adjudication.claimId = claim.claimId;
    } else {
      adjudication = parseAdjudicationUtil(claim.claimId, response.text);
    }

    // Record in ledger
    ledger.appendAdjudication(adjudication);
    allAdjudications.push(adjudication);

    // Transition claim based on outcome
    applyAdjudicationOutcome(claim, adjudication);
  }

  // Synthetic adjudications for verified claims
  for (const claim of verifiedClaims) {
    const adjudication: ClaimAdjudication = {
      claimId: claim.claimId,
      outcome: "accepted",
      rationale: "Verified by peer review without contest",
      finalSummary: claim.finding.summary,
      supportingEvidenceRefs: claim.evidenceRefs,
    };

    ledger.appendAdjudication(adjudication);
    allAdjudications.push(adjudication);
  }

  // Any remaining proposed/under_review claims → mark unresolved
  const remaining = ledger.getClaimsByStatus("proposed", "under_review");
  for (const claim of remaining) {
    markUnresolved(claim);
  }

  const accepted = allAdjudications.filter((a) =>
    a.outcome === "accepted" || a.outcome === "accepted_with_revision",
  ).length;
  const unresolved = ledger.getClaimsByStatus("unresolved").length;

  logger.info("arena.adjudication_done", {
    total: allAdjudications.length,
    accepted,
    unresolved,
  });

  onProgress?.({ type: "adjudication_done", accepted, unresolved });

  return allAdjudications;
}

/**
 * Apply adjudication outcome to claim status.
 */
function applyAdjudicationOutcome(claim: ClaimRecord, adjudication: ClaimAdjudication): void {
  switch (adjudication.outcome) {
    case "accepted":
    case "accepted_with_revision":
      transitionClaim(claim, "verified");
      break;
    case "rejected":
      transitionClaim(claim, "rejected");
      break;
    case "unresolved":
      markUnresolved(claim);
      break;
  }
}

/**
 * Build a fallback adjudication prompt for non-V2 strategies.
 */
function buildFallbackAdjudicationPrompt(topic: string, claim: ClaimRecord): string {
  const challengeText = claim.challenges.length > 0
    ? claim.challenges.map((c) => `[${c.reviewer}] ${c.verdict}: ${c.reason}`).join("\n")
    : "No challenges.";

  const debateText = claim.debateRounds.length > 0
    ? claim.debateRounds.map((r) =>
        `Round ${r.round}:\n` +
        r.participants.map((t) => `  [${t.participant}] ${t.stance}: ${t.summary}`).join("\n") +
        `\n  ${r.resolved ? "→ Resolved" : "→ Unresolved"}`
      ).join("\n\n")
    : "No debate rounds.";

  return (
    `## Topic: ${topic}\n\n` +
    `## Claim Under Adjudication\n` +
    `[${claim.claimId}] ${claim.finding.title}\n${claim.finding.summary}\n` +
    `Owner: ${claim.owner} | Status: ${claim.status}\n\n` +
    `## Challenges\n${challengeText}\n\n` +
    `## Debate\n${debateText}\n\n` +
    `As moderator, adjudicate this claim based on all available evidence.\n` +
    `Respond ONLY with JSON:\n` +
    `{"outcome": "accepted|accepted_with_revision|rejected|unresolved", "rationale": "...", ` +
    `"finalSummary": "revised claim summary if needed", "supportingEvidenceRefs": ["..."]}`
  );
}

/**
 * DebateRounds — contested claims enter structured debate between
 * the claim owner and the primary challenger.
 *
 * Each debate round:
 *   1. Both debaters produce a DebateTurn (stance + argument)
 *   2. Convergence check: all stances are "support" or "narrow" → resolved
 *   3. If max rounds exhausted → stays contested for adjudication
 */

import { createLLMClient } from "../../llm/client-factory.js";
import type {
  ArenaParticipant,
  ArenaStrategy,
  ClaimRecord,
  DebateRound,
  DebateTurn,
  ArenaExecutionLimits,
  ArenaProgressEvent,
} from "../types.js";
import { isStrategyV2 } from "../types.js";
import type { ArenaStrategyV2 } from "../types.js";
import type { ArenaLedger } from "../ledger.js";
import { buildDigest } from "../digest-builder.js";
import { parseDebateTurn as parseDebateTurnUtil } from "../strategies/utils.js";
import { logger } from "../../logging/logger.js";

interface DebateOptions {
  participants: ArenaParticipant[];
  strategy: ArenaStrategy;
  topic: string;
  ledger: ArenaLedger;
  limits: ArenaExecutionLimits;
  maxRounds: number;
  signal?: AbortSignal;
  onProgress?: (event: ArenaProgressEvent) => void;
}

/**
 * Run debate rounds for all contested claims.
 * Returns empty array if no contested claims exist.
 */
export async function runDebateRounds(options: DebateOptions): Promise<DebateRound[]> {
  const { participants, strategy, topic, ledger, limits, maxRounds, signal, onProgress } = options;

  // Select contested claims, capped
  const contested = ledger.getClaimsByStatus("contested")
    .slice(0, limits.maxContestedClaimsForDebate);

  if (contested.length === 0) {
    logger.info("arena.debate_skip", { reason: "no contested claims" });
    return [];
  }

  logger.info("arena.debate_start", {
    contestedCount: contested.length,
    maxRounds,
  });

  const allDebateRounds: DebateRound[] = [];
  const v2 = isStrategyV2(strategy);

  // Debate each claim sequentially (to avoid token explosion from parallelism)
  for (const claim of contested) {
    signal?.throwIfAborted();

    const claimDebateRounds = await debateClaim({
      claim,
      participants,
      strategy,
      v2,
      topic,
      ledger,
      maxRounds,
      signal,
      onProgress,
    });

    allDebateRounds.push(...claimDebateRounds);

    // Attach debate rounds to claim record
    claim.debateRounds.push(...claimDebateRounds);
  }

  return allDebateRounds;
}

interface DebateClaimOptions {
  claim: ClaimRecord;
  participants: ArenaParticipant[];
  strategy: ArenaStrategy;
  v2: boolean;
  topic: string;
  ledger: ArenaLedger;
  maxRounds: number;
  signal?: AbortSignal;
  onProgress?: (event: ArenaProgressEvent) => void;
}

async function debateClaim(options: DebateClaimOptions): Promise<DebateRound[]> {
  const { claim, participants, strategy, v2, topic, ledger, maxRounds, signal, onProgress } = options;

  // Identify debaters: claim owner + primary challenger
  const owner = participants.find((p) => p.name === claim.owner);
  const primaryChallenger = findPrimaryChallenger(claim, participants);

  if (!owner || !primaryChallenger) {
    logger.warn("arena.debate_skip_claim", {
      claimId: claim.claimId,
      reason: "cannot identify debaters",
    });
    return [];
  }

  const debaters = [owner, primaryChallenger];
  const rounds: DebateRound[] = [];
  const allTurns: DebateTurn[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    signal?.throwIfAborted();

    onProgress?.({ type: "debate_round_start", round, claims: [claim.claimId] });

    const digest = buildDigest(ledger, {
      round,
      relevantClaimIds: [claim.claimId],
    });

    // Each debater produces a turn
    const turnPromises = debaters.map(async (p) => {
      const client = await createLLMClient({
        ...p.llm,
        enableStreaming: false,
      });

      const systemPrompt = strategy.crossReviewSystemPrompt(p.name);
      let userContent: string;

      if (v2) {
        userContent = (strategy as ArenaStrategyV2)
          .debateTurnUserPrompt(topic, claim, allTurns, digest);
      } else {
        // Fallback prompt for non-V2 strategies
        userContent = buildFallbackDebatePrompt(topic, claim, allTurns);
      }

      const response = await client.createMessage({
        systemPrompt,
        messages: [{ role: "user", content: userContent }],
        signal,
      });

      logger.info("arena.debate_turn", {
        participant: p.name,
        claimId: claim.claimId,
        round,
        stopReason: response.stopReason,
      });

      if (v2) {
        return (strategy as ArenaStrategyV2).parseDebateTurnResponse(p.name, response.text);
      }
      return parseDebateTurnUtil(p.name, response.text);
    });

    const turns = await Promise.all(turnPromises);
    allTurns.push(...turns);

    // Check convergence
    const resolved = turns.every((t) => t.stance === "support" || t.stance === "narrow");
    const resolutionNote = resolved
      ? `Converged in round ${round}: ${turns.map((t) => `${t.participant}=${t.stance}`).join(", ")}`
      : undefined;

    const debateRound: DebateRound = {
      round,
      claimId: claim.claimId,
      participants: turns,
      resolved,
      resolutionNote,
    };

    rounds.push(debateRound);

    onProgress?.({ type: "debate_round_done", round, resolved: resolved ? 1 : 0 });

    if (resolved) {
      logger.info("arena.debate_converged", {
        claimId: claim.claimId,
        round,
      });
      break;
    }
  }

  return rounds;
}

/**
 * Find the primary challenger — the participant who disagreed or requested evidence.
 */
function findPrimaryChallenger(
  claim: ClaimRecord,
  participants: ArenaParticipant[],
): ArenaParticipant | undefined {
  // Prefer disagree over needs_evidence
  const disagreeChallenge = claim.challenges.find((c) => c.verdict === "disagree");
  const needsEvidenceChallenge = claim.challenges.find((c) => c.verdict === "needs_evidence");
  const challenge = disagreeChallenge ?? needsEvidenceChallenge ?? claim.challenges[0];

  if (!challenge) return undefined;
  return participants.find((p) => p.name === challenge.reviewer);
}

/**
 * Build a fallback debate prompt for non-V2 strategies.
 */
function buildFallbackDebatePrompt(
  topic: string,
  claim: ClaimRecord,
  priorTurns: DebateTurn[],
): string {
  const turnsText = priorTurns.length > 0
    ? priorTurns.map((t) => `[${t.participant}] ${t.stance}: ${t.summary}`).join("\n")
    : "No prior turns.";

  return (
    `## Topic: ${topic}\n\n` +
    `## Contested Claim\n` +
    `[${claim.claimId}] ${claim.finding.title}\n${claim.finding.summary}\n\n` +
    `## Prior Debate\n${turnsText}\n\n` +
    `State your position on this claim. Build on prior turns: cite specific evidence, ` +
    `acknowledge counter-arguments, and explain your reasoning in 150-300 words. ` +
    `Brevity here means missed nuance — depth wins.\n` +
    `Respond ONLY with JSON:\n` +
    `{"stance": "support|oppose|narrow|uncertain", "summary": "your argument", "newEvidenceRefs": ["optional"]}`
  );
}

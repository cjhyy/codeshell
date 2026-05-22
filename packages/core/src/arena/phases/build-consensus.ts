/**
 * ConsensusBuilder — aggregates findings + peer reviews into structured consensus.
 *
 * V1: Program aggregates finding + review data, moderator LLM organizes.
 * V2: When claim data is available, uses claim-aware prompts that distinguish
 *     verified/unresolved/rejected claims.
 *
 * In both paths, the moderator must faithfully reflect aggregated results
 * (no new unsourced conclusions).
 */

import { createLLMClient } from "../../llm/client-factory.js";
import { logger } from "../../logging/logger.js";
import type {
  ArenaParticipant,
  ArenaStrategy,
  ParticipantReport,
  FindingReview,
  ArenaConsensus,
  ClaimStatusSummary,
  ArenaProgressEvent,
} from "../types.js";
import { isStrategyV2 } from "../types.js";
import type { ArenaStrategyV2 } from "../types.js";

interface ConsensusOptions {
  /** The participant that acts as moderator/concluder */
  concluder: ArenaParticipant;
  strategy: ArenaStrategy;
  topic: string;
  reports: ParticipantReport[];
  reviews: FindingReview[];
  /** Claim status summary — when provided, enables claim-aware consensus (V2) */
  claimSummary?: ClaimStatusSummary;
  signal?: AbortSignal;
  onProgress?: (event: ArenaProgressEvent) => void;
}

/**
 * Build structured consensus from participant reports, cross-reviews,
 * and optionally adjudicated claim data.
 */
export async function buildConsensus(options: ConsensusOptions): Promise<ArenaConsensus> {
  const { concluder, strategy, topic, reports, reviews, claimSummary, signal, onProgress } = options;

  onProgress?.({ type: "consensus_start" });

  const client = await createLLMClient({
    ...concluder.llm,
    enableStreaming: false,
  });

  const systemPrompt = strategy.consensusSystemPrompt();

  // Choose user prompt: claim-aware (V2) or standard (V1)
  let userContent: string;
  const v2 = isStrategyV2(strategy);

  if (v2 && claimSummary) {
    userContent = (strategy as ArenaStrategyV2)
      .claimAwareConsensusUserPrompt(topic, reports, reviews, claimSummary);

    logger.info("arena.consensus_claim_aware", {
      verified: claimSummary.verified.length,
      unresolved: claimSummary.unresolved.length,
      contested: claimSummary.contested.length,
      rejected: claimSummary.rejected.length,
    });
  } else {
    userContent = strategy.consensusUserPrompt(topic, reports, reviews);
  }

  const response = await client.createMessage({
    systemPrompt,
    messages: [{ role: "user", content: userContent }],
    signal,
  });

  logger.info("arena.consensus_raw_response", {
    text: response.text,
    stopReason: response.stopReason,
  });

  // If output was truncated by max_tokens, retry with a condensed prompt
  if (response.stopReason === "length") {
    logger.warn("arena.consensus_truncated", {
      textLen: response.text?.length ?? 0,
      maxTokens: concluder.llm.maxTokens,
    });

    const retryResponse = await client.createMessage({
      systemPrompt,
      messages: [
        { role: "user", content: userContent },
        { role: "assistant", content: response.text },
        {
          role: "user",
          content:
            "Your previous response was truncated. Please output a COMPLETE but more concise version of the consensus JSON. " +
            "Keep all sections but use shorter summaries. Respond ONLY with the complete JSON object.",
        },
      ],
      signal,
    });

    logger.info("arena.consensus_retry_response", {
      textLen: retryResponse.text?.length ?? 0,
      stopReason: retryResponse.stopReason,
    });

    if (retryResponse.stopReason === "length") {
      logger.warn("arena.consensus_still_truncated", {
        textLen: retryResponse.text?.length ?? 0,
      });
    }

    const consensus = strategy.parseConsensusResponse(retryResponse.text);
    onProgress?.({ type: "consensus_done", consensus });
    return consensus;
  }

  const consensus = strategy.parseConsensusResponse(response.text);
  onProgress?.({ type: "consensus_done", consensus });

  return consensus;
}

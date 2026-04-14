/**
 * ConsensusBuilder — aggregates findings + peer reviews into structured consensus.
 *
 * 1. Program aggregates finding + review data
 * 2. Moderator LLM organizes into final consensus output
 * 3. Moderator must faithfully reflect aggregated results (no new unsourced conclusions)
 */

import { createLLMClient } from "../../llm/client-factory.js";
import { logger } from "../../logging/logger.js";
import type {
  ArenaParticipant,
  ArenaStrategy,
  ParticipantReport,
  FindingReview,
  ArenaConsensus,
  ArenaProgressEvent,
} from "../types.js";

interface ConsensusOptions {
  /** The participant that acts as moderator/concluder */
  concluder: ArenaParticipant;
  strategy: ArenaStrategy;
  topic: string;
  reports: ParticipantReport[];
  reviews: FindingReview[];
  onProgress?: (event: ArenaProgressEvent) => void;
}

/**
 * Build structured consensus from participant reports and cross-reviews.
 */
export async function buildConsensus(options: ConsensusOptions): Promise<ArenaConsensus> {
  const { concluder, strategy, topic, reports, reviews, onProgress } = options;

  onProgress?.({ type: "consensus_start" });

  const client = await createLLMClient({
    ...concluder.llm,
    enableStreaming: false,
  });

  const systemPrompt = strategy.consensusSystemPrompt();
  const userContent = strategy.consensusUserPrompt(topic, reports, reviews);

  const response = await client.createMessage({
    systemPrompt,
    messages: [{ role: "user", content: userContent }],
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

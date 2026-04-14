/**
 * CrossReview — participants review each other's findings.
 *
 * Each participant sees the other participants' structured findings
 * and provides per-finding verdicts: agree, refine, disagree, needs_evidence.
 */

import { createLLMClient } from "../../llm/client-factory.js";
import type {
  ArenaParticipant,
  ArenaStrategy,
  ParticipantReport,
  FindingReview,
  ArenaProgressEvent,
} from "../types.js";
import { logger } from "../../logging/logger.js";

interface CrossReviewOptions {
  participants: ArenaParticipant[];
  strategy: ArenaStrategy;
  topic: string;
  reports: ParticipantReport[];
  onProgress?: (event: ArenaProgressEvent) => void;
}

/**
 * Run cross-review phase. Each participant reviews the others' findings.
 */
export async function runCrossReview(options: CrossReviewOptions): Promise<FindingReview[]> {
  const { participants, strategy, topic, reports, onProgress } = options;

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

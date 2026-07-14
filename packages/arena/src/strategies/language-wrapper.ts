/**
 * Language-aware strategy wrapper.
 *
 * Detects the language of the user's query and injects a language instruction
 * into all strategy system prompts so the arena output matches the query language.
 */

import type {
  ArenaStrategy,
  ArenaStrategyV2,
  ArenaBaseContext,
  ParticipantReport,
  FindingReview,
  ArenaConsensus,
  FindingKind,
  ClaimRecord,
  ClaimChallenge,
  ClaimAdjudication,
  ClaimStatusSummary,
  DebateTurn,
  DebateRound,
  RoundResearchDigest,
} from "../types.js";
import { isStrategyV2 } from "../types.js";

/**
 * Detect whether the topic is primarily non-English.
 * Returns a language instruction string, or empty if English.
 */
export function detectLanguageInstruction(topic: string): string {
  // Simple heuristic: count CJK / Cyrillic / Arabic / Thai / Korean characters
  // vs ASCII. If non-ASCII ratio is significant, infer the language.
  const nonAscii = topic.replace(/[\x00-\x7F]/g, "");
  const ratio = nonAscii.length / Math.max(topic.length, 1);

  if (ratio < 0.15) return ""; // predominantly English/ASCII

  // Detect specific scripts
  if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(topic)) {
    return "IMPORTANT: The user's query is in Chinese. You MUST respond in Chinese (中文). All text output — summaries, findings, titles, descriptions, rationale — must be written in Chinese. JSON field values must be in Chinese.";
  }
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(topic)) {
    return "IMPORTANT: The user's query is in Japanese. You MUST respond in Japanese (日本語). All text output must be in Japanese. JSON field values must be in Japanese.";
  }
  if (/[\uac00-\ud7af]/.test(topic)) {
    return "IMPORTANT: The user's query is in Korean. You MUST respond in Korean (한국어). All text output must be in Korean. JSON field values must be in Korean.";
  }
  if (/[\u0400-\u04ff]/.test(topic)) {
    return "IMPORTANT: The user's query is in Russian. You MUST respond in Russian (русский). All text output must be in Russian. JSON field values must be in Russian.";
  }
  if (/[\u0600-\u06ff]/.test(topic)) {
    return "IMPORTANT: The user's query is in Arabic. You MUST respond in Arabic (العربية). All text output must be in Arabic. JSON field values must be in Arabic.";
  }

  // Generic fallback for other non-ASCII scripts
  return "IMPORTANT: Respond in the same language as the user's query. All text output — summaries, findings, titles, descriptions — must match the query language.";
}

/**
 * Wrap a strategy to inject language instructions into all system prompts.
 * If the topic is English, returns the original strategy unchanged.
 */
export function withLanguage(strategy: ArenaStrategy, topic: string): ArenaStrategy {
  const langInstruction = detectLanguageInstruction(topic);
  if (!langInstruction) return strategy;

  return {
    researchSystemPrompt(name: string): string {
      return `${langInstruction}\n\n${strategy.researchSystemPrompt(name)}`;
    },
    researchUserPrompt(t: string, ctx: ArenaBaseContext): string {
      return strategy.researchUserPrompt(t, ctx);
    },
    parseResearchResponse(participant: string, text: string): ParticipantReport {
      return strategy.parseResearchResponse(participant, text);
    },
    crossReviewSystemPrompt(reviewerName: string): string {
      return `${langInstruction}\n\n${strategy.crossReviewSystemPrompt(reviewerName)}`;
    },
    crossReviewUserPrompt(t: string, my: ParticipantReport, others: ParticipantReport[]): string {
      return strategy.crossReviewUserPrompt(t, my, others);
    },
    parseCrossReviewResponse(reviewer: string, text: string): FindingReview[] {
      return strategy.parseCrossReviewResponse(reviewer, text);
    },
    consensusSystemPrompt(): string {
      return `${langInstruction}\n\n${strategy.consensusSystemPrompt()}`;
    },
    consensusUserPrompt(t: string, reports: ParticipantReport[], reviews: FindingReview[]): string {
      return strategy.consensusUserPrompt(t, reports, reviews);
    },
    parseConsensusResponse(text: string): ArenaConsensus {
      return strategy.parseConsensusResponse(text);
    },
    preferredFindingKinds(): FindingKind[] {
      return strategy.preferredFindingKinds();
    },

    // ─── V2 forwarding (conditional) ─────────────────────────────
    ...(isStrategyV2(strategy) ? {
      verificationReviewUserPrompt(
        topic: string, myReport: ParticipantReport, claims: ClaimRecord[], digest: RoundResearchDigest,
      ): string {
        return (strategy as ArenaStrategyV2).verificationReviewUserPrompt(topic, myReport, claims, digest);
      },
      parseVerificationReviewResponse(reviewer: string, text: string): ClaimChallenge[] {
        return (strategy as ArenaStrategyV2).parseVerificationReviewResponse(reviewer, text);
      },
      debateTurnUserPrompt(
        topic: string, claim: ClaimRecord, priorTurns: DebateTurn[], digest: RoundResearchDigest,
      ): string {
        return (strategy as ArenaStrategyV2).debateTurnUserPrompt(topic, claim, priorTurns, digest);
      },
      parseDebateTurnResponse(participant: string, text: string): DebateTurn {
        return (strategy as ArenaStrategyV2).parseDebateTurnResponse(participant, text);
      },
      adjudicationUserPrompt(
        topic: string, claim: ClaimRecord, rounds: DebateRound[], digest: RoundResearchDigest,
      ): string {
        return (strategy as ArenaStrategyV2).adjudicationUserPrompt(topic, claim, rounds, digest);
      },
      parseAdjudicationResponse(text: string): ClaimAdjudication {
        return (strategy as ArenaStrategyV2).parseAdjudicationResponse(text);
      },
      claimAwareConsensusUserPrompt(
        topic: string, reports: ParticipantReport[], reviews: FindingReview[], claimSummary: ClaimStatusSummary,
      ): string {
        return (strategy as ArenaStrategyV2).claimAwareConsensusUserPrompt(topic, reports, reviews, claimSummary);
      },
    } : {}),
  };
}

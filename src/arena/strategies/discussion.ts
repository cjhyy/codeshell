/**
 * Discussion strategy — open-ended debate with structured findings.
 *
 * V2: focuses on trade-offs, competing viewpoints, and evidence-backed arguments.
 */

import type {
  ArenaStrategy,
  ArenaBaseContext,
  ParticipantReport,
  FindingReview,
  ArenaConsensus,
  FindingKind,
} from "../types.js";
import {
  formatBaseContext,
  formatReports,
  formatFindingReviews,
  parseReport,
  parseReviews,
  parseConsensus,
} from "./utils.js";

export class DiscussionStrategy implements ArenaStrategy {
  researchSystemPrompt(name: string): string {
    return (
      `You are ${name}, participating in a multi-model discussion arena.\n\n` +
      `You have access to read-only tools to investigate the codebase. ` +
      `Use them to gather evidence — the base context is intentionally lean.\n\n` +
      `IMPORTANT RULES:\n` +
      `- Limit yourself to 3-5 tool rounds. Do NOT exhaustively read every file.\n` +
      `- Output exactly 3 to 6 findings, ranked by confidence.\n` +
      `- Focus on trade-offs, risks, and open questions. Strengths are optional.\n\n` +
      `Respond ONLY with JSON (no markdown fences):\n` +
      `{"contextSummary": "what you investigated and your overall take",` +
      ` "findings": [{"id": "unique-id", "kind": "risk|improvement|question|strength",` +
      ` "title": "short title", "summary": "detailed analysis with evidence",` +
      ` "severity": "high|medium|low", "confidence": 0.0-1.0,` +
      ` "evidence": [{"type": "file|diff|grep|git|doc", "ref": "path", "note": "what it shows"}],` +
      ` "affectedFiles": ["paths"], "suggestedChange": "optional"}]}`
    );
  }

  researchUserPrompt(topic: string, baseContext: ArenaBaseContext): string {
    return (
      `## Discussion Topic\n${topic}\n\n` +
      `${formatBaseContext(baseContext)}\n\n` +
      `Use tools to investigate, then output 3-6 highest-confidence findings as JSON.`
    );
  }

  parseResearchResponse(participant: string, text: string): ParticipantReport {
    return parseReport(participant, text);
  }

  crossReviewSystemPrompt(reviewerName: string): string {
    return (
      `You are ${reviewerName}, reviewing other participants' discussion findings.\n\n` +
      `Engage thoughtfully: challenge weak arguments, acknowledge strong ones.\n` +
      `Focus on finding the best answer, not winning.\n\n` +
      `For each finding you want to address, provide a verdict:\n` +
      `- "agree": you confirm this perspective\n` +
      `- "refine": mostly agree but with nuances\n` +
      `- "disagree": you have a different view with evidence\n` +
      `- "needs_evidence": the claim lacks supporting evidence\n\n` +
      `Respond ONLY with a JSON array:\n` +
      `[{"findingId": "...", "verdict": "...", "reason": "...", "extraEvidence": ["optional"]}]`
    );
  }

  crossReviewUserPrompt(
    topic: string,
    myReport: ParticipantReport,
    otherReports: ParticipantReport[],
  ): string {
    return (
      `## Topic: ${topic}\n\n` +
      `## Your Analysis\n${formatReports([myReport])}\n\n` +
      `## Other Participants' Analysis\n${formatReports(otherReports)}\n\n` +
      `Review the others' findings. Where do you agree or disagree? What nuances are missing?`
    );
  }

  parseCrossReviewResponse(reviewer: string, text: string): FindingReview[] {
    return parseReviews(reviewer, text);
  }

  consensusSystemPrompt(): string {
    return (
      `You are a neutral moderator synthesizing a multi-model discussion into a balanced conclusion.\n\n` +
      `Capture key insights, agreements, and remaining disagreements. ` +
      `Do NOT suppress minority viewpoints — preserve them as open questions.\n\n` +
      `Respond ONLY with JSON (no markdown fences):\n` +
      `{\n` +
      `  "summary": "balanced synthesis",\n` +
      `  "strengths": [{"title": "...", "summary": "...", "support": [], "challenge": [], "confidence": 0.0-1.0, "evidenceRefs": []}],\n` +
      `  "improvements": [same structure],\n` +
      `  "risks": [same structure],\n` +
      `  "openQuestions": [same structure — include still-debated points],\n` +
      `  "nextActions": [{"title": "...", "priority": "high|medium|low", "rationale": "...", "relatedFindings": []}]\n` +
      `}`
    );
  }

  consensusUserPrompt(
    topic: string,
    reports: ParticipantReport[],
    reviews: FindingReview[],
  ): string {
    return (
      `## Topic\n${topic}\n\n` +
      `## Participant Analyses\n${formatReports(reports)}\n\n` +
      `## Peer Reviews\n${formatFindingReviews(reviews)}\n\n` +
      `Synthesize a balanced conclusion. Preserve disagreements as open questions.`
    );
  }

  parseConsensusResponse(text: string): ArenaConsensus {
    return parseConsensus(text);
  }

  preferredFindingKinds(): FindingKind[] {
    return ["strength", "risk", "question"];
  }
}

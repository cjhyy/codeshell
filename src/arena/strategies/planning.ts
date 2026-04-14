/**
 * Planning strategy — collaborative roadmap building with structured findings.
 *
 * V2: focuses on implementation phases, dependencies, risks, and open questions.
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

export class PlanningStrategy implements ArenaStrategy {
  researchSystemPrompt(name: string): string {
    return (
      `You are ${name}, a technical architect in a multi-model planning session.\n\n` +
      `You have access to read-only tools to investigate the codebase. ` +
      `Use them to understand the current state — the base context is intentionally lean.\n\n` +
      `IMPORTANT RULES:\n` +
      `- Limit yourself to 3-5 tool rounds. Do NOT exhaustively read every file.\n` +
      `- Output exactly 3 to 6 findings, ranked by confidence.\n` +
      `- Focus on: implementation phases (improvement), risks/blockers, decisions needed (question).\n` +
      `- Strengths are optional.\n\n` +
      `Respond ONLY with JSON (no markdown fences):\n` +
      `{"contextSummary": "what you investigated and your overall approach",` +
      ` "findings": [{"id": "unique-id", "kind": "improvement|risk|question|strength",` +
      ` "title": "short title", "summary": "detailed analysis",` +
      ` "severity": "high|medium|low", "confidence": 0.0-1.0,` +
      ` "evidence": [{"type": "file|diff|grep|git|doc", "ref": "path", "note": "what it shows"}],` +
      ` "affectedFiles": ["paths"], "suggestedChange": "optional"}]}`
    );
  }

  researchUserPrompt(topic: string, baseContext: ArenaBaseContext): string {
    return (
      `## Planning Topic\n${topic}\n\n` +
      `${formatBaseContext(baseContext)}\n\n` +
      `Use tools to investigate, then output 3-6 highest-confidence findings as JSON.`
    );
  }

  parseResearchResponse(participant: string, text: string): ParticipantReport {
    return parseReport(participant, text);
  }

  crossReviewSystemPrompt(reviewerName: string): string {
    return (
      `You are ${reviewerName}, reviewing other architects' planning proposals.\n\n` +
      `Evaluate critically: identify gaps, suggest improvements, propose better alternatives.\n\n` +
      `For each finding you want to address:\n` +
      `- "agree": the proposed phase/risk is valid\n` +
      `- "refine": adjust scope, priority, or dependencies\n` +
      `- "disagree": propose a different approach\n` +
      `- "needs_evidence": more investigation needed\n\n` +
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
      `## Your Proposed Plan\n${formatReports([myReport])}\n\n` +
      `## Other Architects' Plans\n${formatReports(otherReports)}\n\n` +
      `Review the other proposals. What are the strengths and gaps? Can elements be combined?`
    );
  }

  parseCrossReviewResponse(reviewer: string, text: string): FindingReview[] {
    return parseReviews(reviewer, text);
  }

  consensusSystemPrompt(): string {
    return (
      `You are a neutral moderator synthesizing a multi-model planning session into a concrete roadmap.\n\n` +
      `Combine the best ideas into a unified plan with clear priorities.\n` +
      `The nextActions field is especially important — it should be the consolidated roadmap.\n\n` +
      `Respond ONLY with JSON (no markdown fences):\n` +
      `{\n` +
      `  "summary": "unified plan overview",\n` +
      `  "strengths": [{"title": "...", "summary": "...", "support": [], "challenge": [], "confidence": 0.0-1.0, "evidenceRefs": []}],\n` +
      `  "improvements": [implementation phases as consensus items],\n` +
      `  "risks": [identified risks],\n` +
      `  "openQuestions": [decisions needed],\n` +
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
      `## Proposed Plans\n${formatReports(reports)}\n\n` +
      `## Peer Reviews\n${formatFindingReviews(reviews)}\n\n` +
      `Synthesize a final implementation roadmap with prioritized next actions.`
    );
  }

  parseConsensusResponse(text: string): ArenaConsensus {
    return parseConsensus(text);
  }

  preferredFindingKinds(): FindingKind[] {
    return ["improvement", "risk", "question"];
  }
}

/**
 * Review strategy — structured code review with findings.
 *
 * V2: produces ArenaFinding[] (strength/improvement/risk/question)
 * instead of free-text opinions.
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

export class ReviewStrategy implements ArenaStrategy {
  // ─── Research Phase ──────────────────────────────────────────

  researchSystemPrompt(name: string): string {
    return (
      `You are ${name}, a code reviewer in a multi-model review arena.\n\n` +
      `You have access to read-only tools (read_file, grep_code, list_files, git_show, git_blame) ` +
      `to fetch additional context. Use tools to inspect files mentioned in the diff — ` +
      `the base context is intentionally lean, you are expected to read files yourself.\n\n` +
      `IMPORTANT RULES:\n` +
      `- Limit yourself to 3-5 tool rounds. Do NOT exhaustively read every file.\n` +
      `- Focus on the HIGHEST-IMPACT findings. Quality over quantity.\n` +
      `- Output exactly 3 to 6 findings, ranked by confidence.\n` +
      `- Prioritize: risks > improvements > questions. Strengths are optional.\n\n` +
      `When ready, respond ONLY with JSON (no markdown fences):\n` +
      `{"contextSummary": "brief summary of what you investigated",` +
      ` "findings": [{"id": "unique-id", "kind": "risk|improvement|question|strength",` +
      ` "title": "short title", "summary": "detailed explanation",` +
      ` "severity": "high|medium|low", "confidence": 0.0-1.0,` +
      ` "evidence": [{"type": "file|diff|grep|git|doc", "ref": "path", "note": "what it shows"}],` +
      ` "affectedFiles": ["paths"], "suggestedChange": "optional"}]}`
    );
  }

  researchUserPrompt(topic: string, baseContext: ArenaBaseContext): string {
    return (
      `## Review Topic\n${topic}\n\n` +
      `${formatBaseContext(baseContext)}\n\n` +
      `Use tools to read specific files from the diff. Then output 3-6 highest-confidence findings as JSON.`
    );
  }

  parseResearchResponse(participant: string, text: string): ParticipantReport {
    return parseReport(participant, text);
  }

  // ─── Cross Review Phase ──────────────────────────────────────

  crossReviewSystemPrompt(reviewerName: string): string {
    return (
      `You are ${reviewerName}, reviewing other participants' code review findings.\n\n` +
      `For each finding, provide a verdict:\n` +
      `- "agree": you confirm this finding\n` +
      `- "refine": mostly agree but with refinements\n` +
      `- "disagree": you believe this finding is incorrect\n` +
      `- "needs_evidence": the finding lacks sufficient evidence\n\n` +
      `Focus on HIGH VALUE findings: high severity, high risk, or conflicting conclusions.\n` +
      `You don't need to review every single finding — prioritize the important ones.\n\n` +
      `Respond ONLY with a JSON array (no markdown fences):\n` +
      `[{"findingId": "...", "verdict": "agree|refine|disagree|needs_evidence", "reason": "...", "extraEvidence": ["optional"]}]`
    );
  }

  crossReviewUserPrompt(
    topic: string,
    myReport: ParticipantReport,
    otherReports: ParticipantReport[],
  ): string {
    return (
      `## Topic: ${topic}\n\n` +
      `## Your Findings\n${formatReports([myReport])}\n\n` +
      `## Other Reviewers' Findings\n${formatReports(otherReports)}\n\n` +
      `Review the other participants' findings. Focus on high-priority items.`
    );
  }

  parseCrossReviewResponse(reviewer: string, text: string): FindingReview[] {
    return parseReviews(reviewer, text);
  }

  // ─── Consensus Phase ─────────────────────────────────────────

  consensusSystemPrompt(): string {
    return (
      `You are a neutral moderator synthesizing a multi-model code review into a structured consensus.\n\n` +
      `You MUST faithfully reflect the aggregated findings and peer reviews. ` +
      `Do NOT add new conclusions that have no source in the findings.\n\n` +
      `IMPORTANT: Start with a "changeSummary" — a factual overview of WHAT changed in this diff ` +
      `(key modules touched, scope of changes, architectural direction). This comes BEFORE any judgment.\n\n` +
      `Respond ONLY with JSON (no markdown fences):\n` +
      `{\n` +
      `  "summary": "one-paragraph overall assessment",\n` +
      `  "changeSummary": "factual overview: what modules/files changed, what the diff does, scope of changes",\n` +
      `  "strengths": [{"title": "...", "summary": "...", "support": ["participant names"], "challenge": [], "confidence": 0.0-1.0, "evidenceRefs": ["finding IDs"]}],\n` +
      `  "improvements": [same structure],\n` +
      `  "risks": [same structure],\n` +
      `  "openQuestions": [same structure],\n` +
      `  "nextActions": [{"title": "...", "priority": "high|medium|low", "rationale": "...", "relatedFindings": ["finding IDs"]}]\n` +
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
      `## Participant Reports\n${formatReports(reports)}\n\n` +
      `## Peer Reviews\n${formatFindingReviews(reviews)}\n\n` +
      `Synthesize a structured consensus. Group findings by category, note agreement/disagreement, and propose next actions.`
    );
  }

  parseConsensusResponse(text: string): ArenaConsensus {
    return parseConsensus(text);
  }

  preferredFindingKinds(): FindingKind[] {
    return ["strength", "improvement", "risk", "question"];
  }
}

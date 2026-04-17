/**
 * Review strategy — structured code review with findings.
 *
 * V2: produces ArenaFinding[] (strength/improvement/risk/question)
 * instead of free-text opinions.
 */

import type {
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
import {
  formatBaseContext,
  formatReports,
  formatFindingReviews,
  formatClaimsForReview,
  formatDebateHistory,
  formatClaimSummaryForConsensus,
  formatDigestForPrompt,
  parseReport,
  parseReviews,
  parseConsensus,
  parseChallenges,
  parseDebateTurn,
  parseAdjudication,
} from "./utils.js";

export class ReviewStrategy implements ArenaStrategyV2 {
  // ─── Research Phase ──────────────────────────────────────────

  researchSystemPrompt(name: string): string {
    return (
      `You are ${name}, a reviewer in a multi-model review arena.\n\n` +
      `You may have access to read-only tools to fetch additional context. ` +
      `The base context is intentionally lean — use tools to inspect details as needed.\n\n` +
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
      `You are ${reviewerName}, reviewing other participants' review findings.\n\n` +
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
      `You are a neutral moderator synthesizing a multi-model review into a structured consensus.\n\n` +
      `You MUST faithfully reflect the aggregated findings and peer reviews. ` +
      `Do NOT add new conclusions that have no source in the findings.\n\n` +
      `IMPORTANT: Start with a "subjectSummary" — a factual overview of WHAT is being reviewed ` +
      `(scope, key areas, high-level description). This comes BEFORE any judgment.\n\n` +
      `Respond ONLY with JSON (no markdown fences):\n` +
      `{\n` +
      `  "summary": "one-paragraph overall assessment",\n` +
      `  "subjectSummary": "factual overview of what is being reviewed — scope, key areas, subject description",\n` +
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

  // ─── V2: Verification Review ────────────────────────────────────

  verificationReviewUserPrompt(
    topic: string,
    myReport: ParticipantReport,
    claimsToReview: ClaimRecord[],
    digest: RoundResearchDigest,
  ): string {
    return (
      `## Topic: ${topic}\n\n` +
      `## Your Findings\n${formatReports([myReport])}\n\n` +
      `## Claims to Verify\n${formatClaimsForReview(claimsToReview)}\n\n` +
      `## Evidence Digest\n${formatDigestForPrompt(digest)}\n\n` +
      `Verify each claim against the evidence. For claims lacking evidence, you may request specific checks.\n` +
      `Respond ONLY with a JSON array:\n` +
      `[{"claimId": "...", "verdict": "agree|refine|disagree|needs_evidence", "reason": "...", ` +
      `"supportingEvidenceRefs": ["optional"], "requestedChecks": [{"description": "what to check", "priority": "high|medium|low"}]}]`
    );
  }

  parseVerificationReviewResponse(reviewer: string, text: string): ClaimChallenge[] {
    return parseChallenges(reviewer, text);
  }

  // ─── V2: Debate ─────────────────────────────────────────────────

  debateTurnUserPrompt(
    topic: string,
    claim: ClaimRecord,
    priorTurns: DebateTurn[],
    digest: RoundResearchDigest,
  ): string {
    return (
      `## Topic: ${topic}\n\n` +
      `## Contested Claim\n` +
      `[${claim.claimId}] ${claim.finding.title}\n${claim.finding.summary}\n` +
      `Evidence: ${claim.evidenceRefs.join(", ") || "none"}\n\n` +
      `## Prior Debate\n${formatDebateHistory(priorTurns)}\n\n` +
      `## Evidence Digest\n${formatDigestForPrompt(digest)}\n\n` +
      `State your position on this claim. Be concise and evidence-based.\n` +
      `Respond ONLY with JSON:\n` +
      `{"stance": "support|oppose|narrow|uncertain", "summary": "your argument", "newEvidenceRefs": ["optional"]}`
    );
  }

  parseDebateTurnResponse(participant: string, text: string): DebateTurn {
    return parseDebateTurn(participant, text);
  }

  // ─── V2: Adjudication ──────────────────────────────────────────

  adjudicationUserPrompt(
    topic: string,
    claim: ClaimRecord,
    debateRounds: DebateRound[],
    digest: RoundResearchDigest,
  ): string {
    const debateSummary = debateRounds.length > 0
      ? debateRounds.map((r) =>
          `Round ${r.round}:\n${formatDebateHistory(r.participants)}\n${r.resolved ? "→ Resolved" : "→ Unresolved"}`
        ).join("\n\n")
      : "No debate rounds occurred.";

    return (
      `## Topic: ${topic}\n\n` +
      `## Claim Under Adjudication\n` +
      `[${claim.claimId}] ${claim.finding.title}\n${claim.finding.summary}\n` +
      `Owner: ${claim.owner} | Status: ${claim.status}\n` +
      `Evidence: ${claim.evidenceRefs.join(", ") || "none"}\n\n` +
      `## Challenges\n` +
      claim.challenges.map((c) => `[${c.reviewer}] ${c.verdict}: ${c.reason}`).join("\n") + "\n\n" +
      `## Debate\n${debateSummary}\n\n` +
      `## Evidence Digest\n${formatDigestForPrompt(digest)}\n\n` +
      `As moderator, adjudicate this claim based on all available evidence.\n` +
      `Respond ONLY with JSON:\n` +
      `{"outcome": "accepted|accepted_with_revision|rejected|unresolved", "rationale": "...", ` +
      `"finalSummary": "revised claim summary if needed", "supportingEvidenceRefs": ["..."]}`
    );
  }

  parseAdjudicationResponse(text: string): ClaimAdjudication {
    return parseAdjudication("", text);
  }

  // ─── V2: Claim-Aware Consensus ─────────────────────────────────

  claimAwareConsensusUserPrompt(
    topic: string,
    reports: ParticipantReport[],
    reviews: FindingReview[],
    claimSummary: ClaimStatusSummary,
  ): string {
    return (
      `## Topic\n${topic}\n\n` +
      `## Claim Verification Status\n${formatClaimSummaryForConsensus(claimSummary)}\n\n` +
      `## Participant Reports\n${formatReports(reports)}\n\n` +
      `## Peer Reviews\n${formatFindingReviews(reviews)}\n\n` +
      `Synthesize a structured consensus. Verified claims should appear as high-confidence items. ` +
      `Unresolved claims should appear as open questions. Rejected claims should be excluded or noted as dismissed.`
    );
  }
}

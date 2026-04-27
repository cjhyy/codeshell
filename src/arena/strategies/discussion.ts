/**
 * Discussion strategy — open-ended debate with structured findings.
 *
 * V2: focuses on trade-offs, competing viewpoints, and evidence-backed arguments.
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

export class DiscussionStrategy implements ArenaStrategyV2 {
  researchSystemPrompt(name: string): string {
    return (
      `You are ${name}, participating in a multi-model discussion arena.\n\n` +
      `You may have access to read-only tools to gather evidence. ` +
      `The base context is intentionally lean — use tools as needed.\n\n` +
      `IMPORTANT RULES:\n` +
      `- Limit yourself to 3-5 tool rounds. Do NOT exhaustively read every file.\n` +
      `- Output as many findings as the topic warrants — typically 5-15 for a non-trivial subject. ` +
      `Each finding's "summary" should be 80+ words with concrete evidence and rationale, not a one-liner. ` +
      `Rank by confidence.\n` +
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
      `IMPORTANT: Start with a "subjectSummary" — a factual framing of the topic, current scope, or assumptions under discussion before moving into conclusions.\n\n` +
      `Respond ONLY with JSON (no markdown fences):\n` +
      `{\n` +
      `  "summary": "balanced synthesis",\n` +
      `  "subjectSummary": "factual problem framing or current scope of the discussion",\n` +
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
      `Synthesize a balanced conclusion. Start with a factual subjectSummary, then preserve disagreements as open questions.`
    );
  }

  parseConsensusResponse(text: string): ArenaConsensus {
    return parseConsensus(text);
  }

  preferredFindingKinds(): FindingKind[] {
    return ["strength", "risk", "question"];
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
      `## Your Analysis\n${formatReports([myReport])}\n\n` +
      `## Claims to Verify\n${formatClaimsForReview(claimsToReview)}\n\n` +
      `## Evidence Digest\n${formatDigestForPrompt(digest)}\n\n` +
      `Engage critically with each claim. Challenge weak arguments, acknowledge strong ones. ` +
      `Focus on finding the best answer, not winning.\n` +
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
      `[${claim.claimId}] ${claim.finding.title}\n${claim.finding.summary}\n\n` +
      `## Prior Debate\n${formatDebateHistory(priorTurns)}\n\n` +
      `## Evidence Digest\n${formatDigestForPrompt(digest)}\n\n` +
      `Engage thoughtfully. If the evidence supports the claim, narrow toward agreement. ` +
      `If not, explain why with evidence.\n` +
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
      `## Contested Claim\n` +
      `[${claim.claimId}] ${claim.finding.title}\n${claim.finding.summary}\n` +
      `Owner: ${claim.owner}\n\n` +
      `## Challenges\n` +
      claim.challenges.map((c) => `[${c.reviewer}] ${c.verdict}: ${c.reason}`).join("\n") + "\n\n" +
      `## Debate\n${debateSummary}\n\n` +
      `## Evidence Digest\n${formatDigestForPrompt(digest)}\n\n` +
      `As moderator, synthesize the debate. Preserve minority viewpoints where the evidence is genuinely ambiguous.\n` +
      `Respond ONLY with JSON:\n` +
      `{"outcome": "accepted|accepted_with_revision|rejected|unresolved", "rationale": "...", ` +
      `"finalSummary": "revised claim summary", "supportingEvidenceRefs": ["..."]}`
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
      `## Participant Analyses\n${formatReports(reports)}\n\n` +
      `## Peer Reviews\n${formatFindingReviews(reviews)}\n\n` +
      `Synthesize a balanced conclusion. Verified claims are high-confidence. ` +
      `Unresolved claims should be preserved as open questions — do NOT suppress minority viewpoints.`
    );
  }
}

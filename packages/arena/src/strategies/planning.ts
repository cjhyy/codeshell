/**
 * Planning strategy — collaborative roadmap building with structured findings.
 *
 * V2: focuses on implementation phases, dependencies, risks, and open questions.
 */

import type {
  ArenaStrategyPlanning,
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
  ArenaRoadmapPhase,
  ArenaRoadmapPhaseDetail,
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
  parseDetailExpansion,
} from "./utils.js";

export class PlanningStrategy implements ArenaStrategyPlanning {
  researchSystemPrompt(name: string): string {
    return (
      `You are ${name}, a planner in a multi-model planning session.\n\n` +
      `You may have access to read-only tools to investigate the subject. ` +
      `The base context is intentionally lean — use tools as needed.\n\n` +
      `IMPORTANT RULES:\n` +
      `- Limit yourself to 3-5 tool rounds. Do NOT exhaustively read every file.\n` +
      `- Output as many findings as the topic warrants — typically 5-15 for a non-trivial subject. ` +
      `Each finding's "summary" should be 80+ words with concrete evidence and rationale, not a one-liner. ` +
      `Rank by confidence.\n` +
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
      `Combine the best ideas into a unified plan with clear sequencing, priorities, and delivery phases.\n` +
      `IMPORTANT: the roadmap field is the primary output. Use it to describe 3 to 6 implementation phases. ` +
      `The nextActions field is only for the immediate 3 to 5 actions that should happen next.\n\n` +
      `Respond ONLY with JSON (no markdown fences):\n` +
      `{\n` +
      `  "summary": "unified plan overview",\n` +
      `  "subjectSummary": "factual overview of the current repo/problem scope before proposing changes",\n` +
      `  "strengths": [{"title": "...", "summary": "...", "support": [], "challenge": [], "confidence": 0.0-1.0, "evidenceRefs": []}],\n` +
      `  "improvements": [implementation phases as consensus items],\n` +
      `  "risks": [identified risks],\n` +
      `  "openQuestions": [decisions needed],\n` +
      `  "roadmap": [{"title": "...", "priority": "high|medium|low", "goal": "...", "scope": ["..."], "deliverables": ["..."], "dependencies": ["..."], "risks": ["..."], "successCriteria": ["..."], "relatedFindings": []}],\n` +
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
      `Synthesize a final implementation roadmap.\n` +
      `Requirements:\n` +
      `- Start with a factual subjectSummary of the current scope.\n` +
      `- Produce 3 to 6 roadmap phases covering sequencing, dependencies, deliverables, and success criteria.\n` +
      `- Use nextActions only for the immediate follow-up work, not the entire roadmap.`
    );
  }

  parseConsensusResponse(text: string): ArenaConsensus {
    return parseConsensus(text);
  }

  preferredFindingKinds(): FindingKind[] {
    return ["improvement", "risk", "question"];
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
      `## Your Proposed Plan\n${formatReports([myReport])}\n\n` +
      `## Claims to Verify\n${formatClaimsForReview(claimsToReview)}\n\n` +
      `## Evidence Digest\n${formatDigestForPrompt(digest)}\n\n` +
      `Evaluate each claim for feasibility, sequencing, and dependencies. Challenge proposals that lack evidence.\n` +
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
      `## Contested Planning Proposal\n` +
      `[${claim.claimId}] ${claim.finding.title}\n${claim.finding.summary}\n\n` +
      `## Prior Debate\n${formatDebateHistory(priorTurns)}\n\n` +
      `## Evidence Digest\n${formatDigestForPrompt(digest)}\n\n` +
      `Argue for or against this proposal. Focus on feasibility, risks, and better alternatives.\n` +
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
      `## Contested Proposal\n` +
      `[${claim.claimId}] ${claim.finding.title}\n${claim.finding.summary}\n` +
      `Owner: ${claim.owner}\n\n` +
      `## Challenges\n` +
      claim.challenges.map((c) => `[${c.reviewer}] ${c.verdict}: ${c.reason}`).join("\n") + "\n\n" +
      `## Debate\n${debateSummary}\n\n` +
      `## Evidence Digest\n${formatDigestForPrompt(digest)}\n\n` +
      `As moderator, decide whether this proposal should be included in the final plan.\n` +
      `Respond ONLY with JSON:\n` +
      `{"outcome": "accepted|accepted_with_revision|rejected|unresolved", "rationale": "...", ` +
      `"finalSummary": "revised proposal if needed", "supportingEvidenceRefs": ["..."]}`
    );
  }

  parseAdjudicationResponse(text: string): ClaimAdjudication {
    return parseAdjudication("", text);
  }

  // ─── Planning: Merge-Oriented Review ────────────────────────────

  mergeReviewUserPrompt(
    topic: string,
    myReport: ParticipantReport,
    claimsToReview: ClaimRecord[],
    digest: RoundResearchDigest,
  ): string {
    return (
      `## Topic: ${topic}\n\n` +
      `## Your Proposed Plan\n${formatReports([myReport])}\n\n` +
      `## Candidate Claims (Proposed Phases & Findings)\n${formatClaimsForReview(claimsToReview)}\n\n` +
      `## Evidence Digest\n${formatDigestForPrompt(digest)}\n\n` +
      `You are reviewing planning proposals for MERGE and CONVERGENCE, not for correctness judging.\n\n` +
      `For each claim, decide how it should be incorporated into the final roadmap:\n` +
      `- "agree": the proposed phase/finding is valid as-is\n` +
      `- "refine": merge with another phase, adjust priority/scope/dependencies, or narrow scope\n` +
      `- "disagree": only for proposals that directly contradict repo evidence\n` +
      `- "needs_evidence": mark as open question for further investigation\n\n` +
      `In your reason, use these semantic tags where applicable:\n` +
      `[merge] — combine with another phase\n` +
      `[reprioritize] — change priority ordering\n` +
      `[split_phase] — break into smaller phases\n` +
      `[combine_phase] — merge multiple phases into one\n` +
      `[dependency_risk] — flag missing dependency\n` +
      `[needs_detail] — needs more implementation specifics\n` +
      `[open_question] — convert to open question\n\n` +
      `Respond ONLY with a JSON array:\n` +
      `[{"claimId": "...", "verdict": "agree|refine|disagree|needs_evidence", "reason": "[tag] explanation", ` +
      `"supportingEvidenceRefs": ["optional"], "requestedChecks": [{"description": "what to check", "priority": "high|medium|low"}]}]`
    );
  }

  parseMergeReviewResponse(reviewer: string, text: string): ClaimChallenge[] {
    return parseChallenges(reviewer, text);
  }

  // ─── Planning: Detail Expansion ────────────────────────────────

  detailExpansionSystemPrompt(): string {
    return (
      `You are a senior architect expanding a high-level roadmap phase into a concrete, repo-level implementation plan.\n\n` +
      `You may have access to read-only tools to investigate the codebase. Use them to verify file paths, interfaces, and module boundaries.\n\n` +
      `IMPORTANT RULES:\n` +
      `- Be specific: name actual files, modules, interfaces, and functions.\n` +
      `- If you're uncertain about a target, write "likely: <path>" and note the uncertainty.\n` +
      `- Do not produce vague platitudes like "refactor the module" — say what changes.\n` +
      `- Limit tool usage to 2-3 rounds for verification.\n\n` +
      `Respond ONLY with JSON (no markdown fences):\n` +
      `{"phaseTitle": "...", "objective": "...", "targetFiles": ["..."], ` +
      `"codeChanges": ["specific change descriptions"], ` +
      `"interfaces": ["new or modified interfaces"], ` +
      `"migrationSteps": ["ordered steps"], ` +
      `"validation": ["how to verify"], ` +
      `"effort": "small|medium|large", ` +
      `"blockers": ["blocking issues"], ` +
      `"evidenceRefs": ["refs to supporting evidence"]}`
    );
  }

  detailExpansionUserPrompt(
    topic: string,
    phase: ArenaRoadmapPhase,
    digest: RoundResearchDigest,
  ): string {
    const phaseContext = [
      `Title: ${phase.title}`,
      `Priority: ${phase.priority}`,
      `Goal: ${phase.goal}`,
      phase.scope.length > 0 ? `Scope: ${phase.scope.join("; ")}` : "",
      phase.deliverables.length > 0 ? `Deliverables: ${phase.deliverables.join("; ")}` : "",
      phase.dependencies.length > 0 ? `Dependencies: ${phase.dependencies.join("; ")}` : "",
      phase.risks.length > 0 ? `Risks: ${phase.risks.join("; ")}` : "",
      phase.successCriteria.length > 0 ? `Success Criteria: ${phase.successCriteria.join("; ")}` : "",
      phase.relatedFindings.length > 0 ? `Related Findings: ${phase.relatedFindings.join(", ")}` : "",
    ].filter(Boolean).join("\n");

    return (
      `## Overall Topic\n${topic}\n\n` +
      `## Roadmap Phase to Expand\n${phaseContext}\n\n` +
      `## Evidence Digest\n${formatDigestForPrompt(digest)}\n\n` +
      `Expand this phase into a repo-level implementation plan.\n` +
      `Use tools to verify file paths and interfaces if available.\n` +
      `Answer these questions:\n` +
      `1. Which files/modules need to change?\n` +
      `2. What are the specific code changes?\n` +
      `3. What interfaces need to be added or modified?\n` +
      `4. What are the migration steps (in order)?\n` +
      `5. How do we validate the changes?\n` +
      `6. What is the effort estimate?\n` +
      `7. What are the blockers?`
    );
  }

  parseDetailExpansionResponse(text: string): ArenaRoadmapPhaseDetail {
    return parseDetailExpansion(text);
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
      `## Proposed Plans\n${formatReports(reports)}\n\n` +
      `## Peer Reviews\n${formatFindingReviews(reviews)}\n\n` +
      `Synthesize a final implementation roadmap.\n` +
      `Requirements:\n` +
      `- Verified claims should form the backbone of the roadmap.\n` +
      `- Unresolved claims should appear as open questions or conditional phases.\n` +
      `- Produce 3 to 6 roadmap phases with sequencing, dependencies, deliverables, and success criteria.\n` +
      `- Use nextActions only for immediate follow-up work.`
    );
  }
}

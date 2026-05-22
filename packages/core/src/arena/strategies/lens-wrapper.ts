/**
 * Lens-aware strategy wrapper.
 *
 * Composes a mode strategy with lens-specific prompts:
 *   systemPrompt = modeStrategy.systemPrompt() + lensPrompt + toolGuidance
 *
 * This achieves the separation described in the architecture doc:
 * - Strategy (mode) → how to collaborate
 * - Lens → from what perspective
 */

import type {
  ArenaStrategy,
  ArenaStrategyV2,
  ArenaStrategyPlanning,
  ArenaBaseContext,
  ParticipantReport,
  FindingReview,
  ArenaConsensus,
  FindingKind,
  ArenaPlan,
  ArenaRoadmapPhase,
  ArenaRoadmapPhaseDetail,
  ClaimRecord,
  ClaimChallenge,
  ClaimAdjudication,
  ClaimStatusSummary,
  DebateTurn,
  DebateRound,
  RoundResearchDigest,
} from "../types.js";
import { isStrategyV2, isStrategyPlanning } from "../types.js";
import { resolveLenses, buildLensPrompt } from "../lenses/index.js";

/**
 * Wrap a strategy to inject lens-specific role and criteria prompts.
 * If no plan is provided, returns the original strategy unchanged.
 */
export function withLens(strategy: ArenaStrategy, plan: ArenaPlan): ArenaStrategy {
  const lenses = resolveLenses(plan.lenses);
  if (lenses.length === 0) return strategy;

  const participantLensPrompt = buildLensPrompt(lenses, "participant");
  const reviewerLensPrompt = buildLensPrompt(lenses, "reviewer");
  const moderatorLensPrompt = buildLensPrompt(lenses, "moderator");

  const participantPlanPrompt = buildPlanPrompt(plan, "participant");
  const reviewerPlanPrompt = buildPlanPrompt(plan, "reviewer");
  const moderatorPlanPrompt = buildPlanPrompt(plan, "moderator");

  return {
    researchSystemPrompt(name: string): string {
      return [
        strategy.researchSystemPrompt(name),
        "",
        "── Analysis Perspective ──",
        participantLensPrompt,
        "",
        "── Scenario Support ──",
        participantPlanPrompt,
      ].join("\n");
    },
    researchUserPrompt(topic: string, ctx: ArenaBaseContext): string {
      return [formatPlanBrief(plan), "", strategy.researchUserPrompt(topic, ctx)].join("\n");
    },
    parseResearchResponse(participant: string, text: string): ParticipantReport {
      return strategy.parseResearchResponse(participant, text);
    },
    crossReviewSystemPrompt(reviewerName: string): string {
      return [
        strategy.crossReviewSystemPrompt(reviewerName),
        "",
        "── Review Perspective ──",
        reviewerLensPrompt,
        "",
        "── Scenario Support ──",
        reviewerPlanPrompt,
      ].join("\n");
    },
    crossReviewUserPrompt(topic: string, my: ParticipantReport, others: ParticipantReport[]): string {
      return [formatPlanBrief(plan), "", strategy.crossReviewUserPrompt(topic, my, others)].join("\n");
    },
    parseCrossReviewResponse(reviewer: string, text: string): FindingReview[] {
      return strategy.parseCrossReviewResponse(reviewer, text);
    },
    consensusSystemPrompt(): string {
      return [
        strategy.consensusSystemPrompt(),
        "",
        "── Moderator Perspective ──",
        moderatorLensPrompt,
        "",
        "── Scenario Support ──",
        moderatorPlanPrompt,
      ].join("\n");
    },
    consensusUserPrompt(topic: string, reports: ParticipantReport[], reviews: FindingReview[]): string {
      return [formatPlanBrief(plan), "", strategy.consensusUserPrompt(topic, reports, reviews)].join("\n");
    },
    parseConsensusResponse(text: string): ArenaConsensus {
      return strategy.parseConsensusResponse(text);
    },
    preferredFindingKinds(): FindingKind[] {
      // Merge mode + lens preferred kinds, deduplicated
      const modeKinds = strategy.preferredFindingKinds();
      const lensKinds = lenses.flatMap((l) => l.preferredFindingKinds);
      const planKinds = plan.outputShape.emphasize;
      const seen = new Set<FindingKind>();
      const result: FindingKind[] = [];
      for (const k of [...planKinds, ...modeKinds, ...lensKinds]) {
        if (!seen.has(k)) { seen.add(k); result.push(k); }
      }
      return result;
    },

    // ─── V2 forwarding (conditional) ─────────────────────────────
    ...(isStrategyV2(strategy) ? {
      verificationReviewUserPrompt(
        topic: string, myReport: ParticipantReport, claims: ClaimRecord[], digest: RoundResearchDigest,
      ): string {
        return [formatPlanBrief(plan), "", (strategy as ArenaStrategyV2).verificationReviewUserPrompt(topic, myReport, claims, digest)].join("\n");
      },
      parseVerificationReviewResponse(reviewer: string, text: string): ClaimChallenge[] {
        return (strategy as ArenaStrategyV2).parseVerificationReviewResponse(reviewer, text);
      },
      debateTurnUserPrompt(
        topic: string, claim: ClaimRecord, priorTurns: DebateTurn[], digest: RoundResearchDigest,
      ): string {
        return [formatPlanBrief(plan), "", (strategy as ArenaStrategyV2).debateTurnUserPrompt(topic, claim, priorTurns, digest)].join("\n");
      },
      parseDebateTurnResponse(participant: string, text: string): DebateTurn {
        return (strategy as ArenaStrategyV2).parseDebateTurnResponse(participant, text);
      },
      adjudicationUserPrompt(
        topic: string, claim: ClaimRecord, rounds: DebateRound[], digest: RoundResearchDigest,
      ): string {
        return [formatPlanBrief(plan), "", (strategy as ArenaStrategyV2).adjudicationUserPrompt(topic, claim, rounds, digest)].join("\n");
      },
      parseAdjudicationResponse(text: string): ClaimAdjudication {
        return (strategy as ArenaStrategyV2).parseAdjudicationResponse(text);
      },
      claimAwareConsensusUserPrompt(
        topic: string, reports: ParticipantReport[], reviews: FindingReview[], claimSummary: ClaimStatusSummary,
      ): string {
        return [formatPlanBrief(plan), "", (strategy as ArenaStrategyV2).claimAwareConsensusUserPrompt(topic, reports, reviews, claimSummary)].join("\n");
      },
    } : {}),

    // ─── Planning forwarding (conditional) ──────────────────────
    ...(isStrategyPlanning(strategy) ? {
      mergeReviewUserPrompt(
        topic: string, myReport: ParticipantReport, claims: ClaimRecord[], digest: RoundResearchDigest,
      ): string {
        return [formatPlanBrief(plan), "", (strategy as ArenaStrategyPlanning).mergeReviewUserPrompt(topic, myReport, claims, digest)].join("\n");
      },
      parseMergeReviewResponse(reviewer: string, text: string): ClaimChallenge[] {
        return (strategy as ArenaStrategyPlanning).parseMergeReviewResponse(reviewer, text);
      },
      detailExpansionSystemPrompt(): string {
        return [
          (strategy as ArenaStrategyPlanning).detailExpansionSystemPrompt(),
          "",
          "── Moderator Perspective ──",
          moderatorLensPrompt,
        ].join("\n");
      },
      detailExpansionUserPrompt(
        topic: string, phase: ArenaRoadmapPhase, digest: RoundResearchDigest,
      ): string {
        return [formatPlanBrief(plan), "", (strategy as ArenaStrategyPlanning).detailExpansionUserPrompt(topic, phase, digest)].join("\n");
      },
      parseDetailExpansionResponse(text: string): ArenaRoadmapPhaseDetail {
        return (strategy as ArenaStrategyPlanning).parseDetailExpansionResponse(text);
      },
    } : {}),
  };
}

function buildPlanPrompt(plan: ArenaPlan, phase: "participant" | "reviewer" | "moderator"): string {
  const sources = plan.sources.map((s) => s.kind).join(", ");
  const targets = formatTargets(plan.subject.targets);
  const emphasis = formatEmphasis(plan.outputShape.emphasize);
  const notes = [
    `Subject: ${plan.subject.kind} — ${plan.subject.label}${targets ? ` (${targets})` : ""}`,
    `Evidence sources: ${sources || "none"}`,
    `Overview label: ${plan.outputShape.overviewLabel}`,
    `Emphasize these finding types first: ${emphasis}`,
    "Only draw conclusions from available evidence. When evidence is thin, narrow the claim or call it out explicitly.",
    ...buildScenarioNotes(plan, phase),
  ];
  return notes.map((line) => `- ${line}`).join("\n");
}

function formatPlanBrief(plan: ArenaPlan): string {
  const targets = formatTargets(plan.subject.targets);
  const lenses = plan.lenses.map((l) => l.name).join(", ");
  const sources = plan.sources.map((s) => s.kind).join(", ");

  return [
    "## Arena Plan",
    `- Mode: ${plan.mode}`,
    `- Subject: ${plan.subject.kind} — ${plan.subject.label}${targets ? ` (${targets})` : ""}`,
    `- Lenses: ${lenses || "general"}`,
    `- Sources: ${sources || "none"}`,
    `- Output focus: ${formatEmphasis(plan.outputShape.emphasize)}`,
    `- Overview label: ${plan.outputShape.overviewLabel}`,
  ].join("\n");
}

function buildScenarioNotes(
  plan: ArenaPlan,
  phase: "participant" | "reviewer" | "moderator",
): string[] {
  const notes: string[] = [];

  switch (plan.subject.kind) {
    case "changes":
      notes.push(
        phase === "participant"
          ? "Treat this as a change-focused analysis: inspect behavioral impact, regressions, interfaces, and compatibility."
          : phase === "reviewer"
            ? "Challenge findings that are not grounded in changed behavior, affected files, or nearby code paths."
            : "Summarize the concrete impact of the changes before giving judgment.",
      );
      break;
    case "files":
      notes.push(
        phase === "participant"
          ? "Stay anchored to the named files/modules and their immediate call sites instead of drifting into unrelated areas."
          : phase === "reviewer"
            ? "Prioritize corrections to claims that overgeneralize beyond the named files/modules."
            : "Keep the conclusion scoped to the named files/modules and their direct implications.",
      );
      break;
    case "docs":
      notes.push(
        phase === "participant"
          ? "Treat this as a document-centric scene: look for ambiguity, missing acceptance criteria, edge cases, and implementation gaps."
          : phase === "reviewer"
            ? "Challenge findings that skip over unclear requirements, contradictory wording, or unsupported feasibility assumptions."
            : "Synthesize the document review around completeness, feasibility, and decision-ready gaps.",
      );
      break;
    case "topic":
      notes.push(
        phase === "participant"
          ? "Treat this as a topic discussion: surface assumptions, trade-offs, and decision criteria instead of pretending there is hard repo evidence."
          : phase === "reviewer"
            ? "Push back on overconfident claims and preserve unresolved trade-offs as open questions."
            : "Preserve disagreement where needed and make assumptions explicit.",
      );
      break;
    case "mixed":
      notes.push(
        phase === "participant"
          ? "This is a mixed scene: reconcile code, docs, and topic-level evidence instead of analyzing each source in isolation."
          : phase === "reviewer"
            ? "Check whether claims actually connect the different evidence sources, rather than citing only one side."
            : "Unify the conclusion across repo facts, documents, and higher-level reasoning.",
      );
      break;
  }

  const sourceKinds = new Set(plan.sources.map((s) => s.kind));
  if (sourceKinds.has("docs") && sourceKinds.has("repo")) {
    notes.push(
      phase === "moderator"
        ? "If documents and repo evidence diverge, call out the mismatch explicitly instead of collapsing it into a single conclusion."
        : "Cross-check document claims against the current repo structure when possible.",
    );
  } else if (sourceKinds.has("web")) {
    notes.push(
      phase === "moderator"
        ? "Separate external references from local repo facts in the synthesis."
        : "Keep external research distinct from local evidence and label it clearly.",
    );
  } else if (sourceKinds.has("none")) {
    notes.push("No external evidence is expected here; reason from the prompt and make assumptions visible.");
  }

  if (plan.mode === "planning") {
    notes.push(
      phase === "moderator"
        ? "When enough evidence exists, turn the conclusion into a staged roadmap with sequencing, dependencies, and success criteria."
        : "Prefer findings that help phase work, sequence dependencies, or expose migration/blocker risks.",
    );
  }

  return notes;
}

function formatEmphasis(kinds: FindingKind[]): string {
  return kinds.length > 0 ? kinds.join(", ") : "risk, improvement";
}

function formatTargets(targets?: string[]): string {
  return Array.isArray(targets) && targets.length > 0 ? targets.join(", ") : "";
}

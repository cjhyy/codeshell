/**
 * Arena — multi-model collaborative analysis engine.
 *
 * Evidence-Driven Pipeline:
 *   0. Planner            → understand what the user wants (mode, lenses, sources)
 *   1. EvidenceProviders   → collect artifacts from selected sources
 *   2. Strategy + Lens     → compose prompts (mode flow + perspective)
 *   3. ToolSelector        → determine which tools participants can use
 *   4. ParticipantResearch  → each model investigates independently (parallel)
 *   4b. ClaimRegistry      → register findings as claims, populate ledger
 *   5. VerificationReview   → claim-aware cross-review with evidence digests
 *   7. DebateRounds         → contested claims enter structured debate
 *   8. Adjudication         → moderator rules on contested claims
 *   6. ConsensusBuilder     → claim-aware structured consensus
 */

import { logger } from "../logging/logger.js";
import type {
  ArenaConfig,
  ArenaMode,
  ArenaResultV2,
  ArenaStrategy,
  ArenaExecutionLimits,
  ClaimStatusSummary,
} from "./types.js";
import { ARENA_MODE_DEFAULTS, DEFAULT_EXECUTION_LIMITS, isStrategyPlanning } from "./types.js";
import { getStrategy, getStrategyForPlan } from "./strategies/index.js";
import { planArena } from "./planner.js";
import type { PlannerFlags } from "./planner.js";
import { collectEvidence } from "./providers/index.js";
import { selectTools } from "./tools/selector.js";
import { runParticipantResearchWithDossiers } from "./phases/participant-research.js";
import { runVerificationReview } from "./phases/cross-review.js";
import { runDebateRounds } from "./phases/debate-rounds.js";
import { runAdjudication } from "./phases/adjudication.js";
import { buildConsensus } from "./phases/build-consensus.js";
import { runDetailExpansion } from "./phases/planning-detail-expansion.js";
import { withLanguage } from "./strategies/language-wrapper.js";
import { ArenaLedger } from "./ledger.js";
import { registerClaims } from "./phases/claim-registry.js";

export class Arena {
  private config: Required<Pick<ArenaConfig, "maxDiscussionRounds" | "mode">> & ArenaConfig;
  private strategy: ArenaStrategy;
  private limits: ArenaExecutionLimits;

  constructor(config: ArenaConfig) {
    if (config.participants.length < 2) {
      throw new Error("Arena requires at least 2 participants");
    }

    const mode: ArenaMode = config.mode ?? "review";
    const defaults = ARENA_MODE_DEFAULTS[mode];

    this.config = {
      mode,
      maxDiscussionRounds: config.maxDiscussionRounds ?? defaults.maxDiscussionRounds,
      ...config,
    };

    this.limits = config.executionLimits ?? DEFAULT_EXECUTION_LIMITS;

    // Initial strategy — will be overridden in run() with lens + language wrappers
    this.strategy = config.strategy ?? getStrategy(mode);
  }

  /**
   * Run a full arena session.
   *
   * @param topic  - User's topic/request (natural language)
   * @param flags  - Optional explicit overrides (mode, base, head)
   */
  async run(topic: string, flags?: PlannerFlags): Promise<ArenaResultV2> {
    const participantNames = this.config.participants.map((p) => p.name);
    const signal = this.config.signal;
    logger.info("arena.start", { mode: this.config.mode, participants: participantNames });

    signal?.throwIfAborted();

    // ─── Phase 0: Plan ────────────────────────────────────────
    const llmConfig = this.config.participants[0].llm;
    const plan = await planArena(topic, llmConfig, flags, signal);
    this.config.onProgress?.({ type: "plan_resolved", plan });
    logger.info("arena.plan", {
      mode: plan.mode,
      lenses: plan.lenses.map((l) => l.name),
      sources: plan.sources.map((s) => s.kind),
      subject: plan.subject.label,
      confidence: plan.confidence,
    });

    if (!flags?.mode && plan.mode !== this.config.mode) {
      this.config.mode = plan.mode;
    }

    signal?.throwIfAborted();

    // ─── Phase 1: Collect Evidence ────────────────────────────
    // Bridge collectEvidence's lifecycle events to the public
    // ArenaProgressEvent stream so the UI sees "collecting from
    // repo..." instead of a silent pause.
    const onProgress = this.config.onProgress;
    const { artifacts, quickFacts } = await collectEvidence(plan, topic, {
      signal,
      onProgress: (e) => {
        if (e.type === "evidence_started") {
          onProgress?.({ type: "evidence_started", source: e.source });
        } else {
          onProgress?.({
            type: "evidence_source_done",
            source: e.source,
            count: e.count ?? 0,
            durationMs: e.durationMs ?? 0,
            timedOut: e.timedOut ?? false,
          });
        }
      },
    });
    onProgress?.({ type: "evidence_collected", artifacts });
    logger.info("arena.evidence", {
      artifactCount: artifacts.length,
      sources: plan.sources.map((s) => s.kind),
    });

    const baseContext = { plan, artifacts, quickFacts };

    // ─── Phase 2: Compose Strategy ────────────────────────────
    this.strategy = this.config.strategy ?? getStrategyForPlan(plan);
    this.strategy = withLanguage(this.strategy, topic);

    // ─── Phase 3: Select Tools ────────────────────────────────
    const contextTools = this.config.enableContextTools !== false
      ? selectTools(plan)
      : undefined;

    signal?.throwIfAborted();

    // ─── Phase 4: Participant Research (parallel) ─────────────
    logger.info("arena.research_phase", { participants: participantNames });
    const researchResults = await runParticipantResearchWithDossiers({
      participants: this.config.participants,
      strategy: this.strategy,
      topic,
      baseContext,
      enableContextTools: this.config.enableContextTools ?? true,
      contextTools,
      signal,
      onProgress: this.config.onProgress,
    });

    const reports = researchResults.map((r) => r.report);
    const dossiers = researchResults.map((r) => r.dossier);

    signal?.throwIfAborted();

    // ─── Phase 4b: Claim Registry ─────────────────────────────
    const ledger = new ArenaLedger();

    // Populate ledger with dossiers
    for (const dossier of dossiers) {
      ledger.appendDossier(dossier);
    }

    // Register findings as claims
    const claims = registerClaims({
      dossiers,
      ledger,
      onProgress: this.config.onProgress,
    });

    logger.info("arena.claims_registered", {
      claimCount: claims.length,
      byOwner: Object.fromEntries(
        participantNames.map((name) => [
          name,
          claims.filter((c) => c.owner === name).length,
        ]),
      ),
    });

    signal?.throwIfAborted();

    // ─── Phase 5: Mode Policy Router ─────────────────────────
    //
    // Planning mode: merge-oriented review → roadmap consensus → detail expansion
    // Review/Discussion mode: verification review → debate → adjudication → consensus

    const concluderName = this.config.concluder ?? participantNames[0];
    const concluderMatch = this.config.participants.find((p) => p.name === concluderName);
    if (!concluderMatch && this.config.concluder) {
      logger.warn("arena.concluder_not_found", {
        requested: this.config.concluder,
        fallback: this.config.participants[0].name,
      });
    }
    const concluder = concluderMatch ?? this.config.participants[0];

    const enableTools = this.config.enableContextTools !== false;

    if (this.config.mode === "planning") {
      return this.runPlanningPath({
        topic, participantNames, plan, baseContext, reports, dossiers, ledger,
        concluder, contextTools, enableContextTools: enableTools, signal,
      });
    }

    return this.runReviewDiscussionPath({
      topic, participantNames, plan, baseContext, reports, dossiers, ledger, concluder, signal,
    });
  }

  /**
   * Planning path: merge-oriented review → roadmap consensus → detail expansion.
   *
   * Planning mode does NOT enter heavy debate/adjudication. Contested findings
   * are converted to open questions or dependency risks in the roadmap.
   */
  private async runPlanningPath(ctx: PathContext): Promise<ArenaResultV2> {
    const {
      topic, participantNames, plan, baseContext, reports, dossiers,
      ledger, concluder, contextTools, enableContextTools, signal,
    } = ctx;

    // ─── Merge-Oriented Review ───────────────────────────────
    logger.info("arena.planning_merge_review_phase");
    const { reviews } = await runVerificationReview({
      participants: this.config.participants,
      strategy: this.strategy,
      topic,
      reports,
      ledger,
      limits: this.limits,
      mode: "planning",
      signal,
      onProgress: this.config.onProgress,
    });

    signal?.throwIfAborted();

    // ─── Roadmap Consensus ───────────────────────────────────
    const allClaims = ledger.getAllClaims();
    const claimSummary: ClaimStatusSummary = {
      verified: allClaims.filter((c) => c.status === "verified"),
      contested: allClaims.filter((c) => c.status === "contested"),
      unresolved: allClaims.filter((c) => c.status === "unresolved"),
      rejected: allClaims.filter((c) => c.status === "rejected"),
    };

    logger.info("arena.planning_consensus_phase", { concluder: concluder.name });
    const consensus = await buildConsensus({
      concluder,
      strategy: this.strategy,
      topic,
      reports,
      reviews,
      claimSummary,
      signal,
      onProgress: this.config.onProgress,
    });

    signal?.throwIfAborted();

    // ─── Detail Expansion ────────────────────────────────────
    if (consensus.roadmap.length > 0 && isStrategyPlanning(this.strategy)) {
      logger.info("arena.detail_expansion_phase", { phaseCount: consensus.roadmap.length });
      try {
        const details = await runDetailExpansion({
          concluder,
          strategy: this.strategy,
          topic,
          phases: consensus.roadmap,
          ledger,
          limits: this.limits,
          enableContextTools,
          contextTools,
          signal,
          onProgress: this.config.onProgress,
        });
        consensus.roadmapDetails = details;
      } catch (err) {
        // Detail expansion is non-critical — degrade gracefully
        logger.warn("arena.detail_expansion_failed", {
          error: (err as Error).message,
          phaseCount: consensus.roadmap.length,
        });
      }
    }

    return {
      topic,
      mode: this.config.mode,
      participants: participantNames,
      plan,
      baseContext,
      reports,
      dossiers,
      claims: allClaims,
      reviews,
      consensus,
    };
  }

  /**
   * Review/Discussion path: verification review → debate → adjudication → consensus.
   *
   * This is the heavy trust loop for claim verification.
   */
  private async runReviewDiscussionPath(ctx: PathContext): Promise<ArenaResultV2> {
    const { topic, participantNames, plan, baseContext, reports, dossiers, ledger, concluder, signal } = ctx;

    // ─── Verification Review (parallel) ──────────────────────
    logger.info("arena.verification_review_phase");
    const { reviews } = await runVerificationReview({
      participants: this.config.participants,
      strategy: this.strategy,
      topic,
      reports,
      ledger,
      limits: this.limits,
      signal,
      onProgress: this.config.onProgress,
    });

    signal?.throwIfAborted();

    // ─── Debate Rounds ───────────────────────────────────────
    logger.info("arena.debate_phase");
    const debateRounds = await runDebateRounds({
      participants: this.config.participants,
      strategy: this.strategy,
      topic,
      ledger,
      limits: this.limits,
      maxRounds: this.config.maxDiscussionRounds,
      signal,
      onProgress: this.config.onProgress,
    });

    signal?.throwIfAborted();

    // ─── Adjudication ────────────────────────────────────────
    logger.info("arena.adjudication_phase", { concluder: concluder.name });
    const adjudications = await runAdjudication({
      concluder,
      strategy: this.strategy,
      topic,
      ledger,
      signal,
      onProgress: this.config.onProgress,
    });

    signal?.throwIfAborted();

    // ─── Consensus (claim-aware) ─────────────────────────────
    const allClaims = ledger.getAllClaims();
    const claimSummary: ClaimStatusSummary = {
      verified: allClaims.filter((c) => c.status === "verified"),
      contested: allClaims.filter((c) => c.status === "contested"),
      unresolved: allClaims.filter((c) => c.status === "unresolved"),
      rejected: allClaims.filter((c) => c.status === "rejected"),
    };

    logger.info("arena.consensus_phase", {
      concluder: concluder.name,
      verified: claimSummary.verified.length,
      unresolved: claimSummary.unresolved.length,
    });
    const consensus = await buildConsensus({
      concluder,
      strategy: this.strategy,
      topic,
      reports,
      reviews,
      claimSummary,
      signal,
      onProgress: this.config.onProgress,
    });

    return {
      topic,
      mode: this.config.mode,
      participants: participantNames,
      plan,
      baseContext,
      reports,
      dossiers,
      claims: allClaims,
      reviews,
      debateRounds,
      adjudications,
      consensus,
    };
  }
}

/** Shared context for both execution paths */
interface PathContext {
  topic: string;
  participantNames: string[];
  plan: import("./types.js").ArenaPlan;
  baseContext: import("./types.js").ArenaBaseContext;
  reports: import("./types.js").ParticipantReport[];
  dossiers: import("./types.js").ResearchDossier[];
  ledger: ArenaLedger;
  concluder: import("./types.js").ArenaParticipant;
  /** Context tools for detail expansion (planning path) */
  contextTools?: import("../types.js").ToolDefinition[];
  enableContextTools?: boolean;
  signal?: AbortSignal;
}

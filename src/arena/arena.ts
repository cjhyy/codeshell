/**
 * Arena — multi-model collaborative analysis engine (V2).
 *
 * Pipeline:
 *   0. IntentResolver    → understand what the user wants
 *   1. ScopeResolver     → map intent to executable scope
 *   2. SharedFactCollector → gather base facts (no conclusions)
 *   3. ParticipantResearch → each model investigates independently (parallel)
 *   4. CrossReview        → models review each other's findings (parallel)
 *   5. ConsensusBuilder   → structured consensus from aggregated evidence
 *
 * All mode-specific behavior (prompts, parsing, finding emphasis) is
 * delegated to an ArenaStrategy.
 */

import { logger } from "../logging/logger.js";
import type {
  ArenaConfig,
  ArenaMode,
  ArenaResultV2,
  ArenaStrategy,
  ArenaIntentSpec,
  ArenaScopeSpec,
  ArenaBaseContext,
  ParticipantReport,
  FindingReview,
  ArenaConsensus,
} from "./types.js";
import { ARENA_MODE_DEFAULTS } from "./types.js";
import { getStrategy } from "./strategies/index.js";
import { resolveIntent } from "./intent-resolver.js";
import type { ExplicitFlags } from "./intent-resolver.js";
import { resolveScope } from "./scope-resolver.js";
import { collectSharedFacts } from "./context/shared-facts.js";
import { runParticipantResearch } from "./phases/participant-research.js";
import { runCrossReview } from "./phases/cross-review.js";
import { buildConsensus } from "./phases/build-consensus.js";
import { withLanguage } from "./strategies/language-wrapper.js";

export class Arena {
  private config: Required<Pick<ArenaConfig, "maxDiscussionRounds" | "mode">> & ArenaConfig;
  private strategy: ArenaStrategy;

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

    this.strategy = config.strategy ?? getStrategy(mode);
  }

  /**
   * Run a full arena session with the V2 pipeline.
   *
   * @param topic - User's topic/request
   * @param flags - Optional explicit CLI flags (mode, base, head)
   */
  async run(topic: string, flags?: ExplicitFlags): Promise<ArenaResultV2> {
    const participantNames = this.config.participants.map((p) => p.name);
    logger.info("arena.start", { mode: this.config.mode, participants: participantNames });

    // Phase 0: Intent Resolution
    const llmConfig = this.config.participants[0].llm;
    const intent = await resolveIntent(topic, llmConfig, flags);
    // Override mode from intent if no explicit mode was set
    if (!flags?.mode && intent.mode !== this.config.mode) {
      this.config.mode = intent.mode;
      this.strategy = this.config.strategy ?? getStrategy(intent.mode);
    }
    // Wrap strategy with language detection so output matches query language
    this.strategy = withLanguage(this.strategy, topic);
    this.config.onProgress?.({ type: "intent_resolved", intent });
    logger.info("arena.intent", { intent });

    // Phase 1: Scope Resolution
    const scope = resolveScope(intent);
    this.config.onProgress?.({ type: "scope_resolved", scope });
    logger.info("arena.scope", { scope: scope.label });

    // Phase 2: Shared Fact Collection
    const baseContext = collectSharedFacts(scope);
    this.config.onProgress?.({ type: "facts_collected", context: baseContext });
    logger.info("arena.facts", {
      artifacts: baseContext.rawArtifacts.length,
      keyFiles: baseContext.codeFacts.keyFiles.length,
    });

    // Phase 3: Participant Research (parallel)
    logger.info("arena.research_phase", { participants: participantNames });
    const reports = await runParticipantResearch({
      participants: this.config.participants,
      strategy: this.strategy,
      topic,
      baseContext,
      enableContextTools: this.config.enableContextTools ?? true,
      onProgress: this.config.onProgress,
    });

    // Phase 4: Cross Review (parallel)
    logger.info("arena.cross_review_phase");
    const reviews = await runCrossReview({
      participants: this.config.participants,
      strategy: this.strategy,
      topic,
      reports,
      onProgress: this.config.onProgress,
    });

    // Phase 5: Consensus
    const concluderName = this.config.concluder ?? participantNames[0];
    const concluder = this.config.participants.find((p) => p.name === concluderName)
      ?? this.config.participants[0];

    logger.info("arena.consensus_phase", { concluder: concluder.name });
    const consensus = await buildConsensus({
      concluder,
      strategy: this.strategy,
      topic,
      reports,
      reviews,
      onProgress: this.config.onProgress,
    });

    return {
      topic,
      mode: this.config.mode,
      participants: participantNames,
      intent,
      scope,
      baseContext,
      reports,
      reviews,
      consensus,
      totalRounds: 1, // V2 uses single research + review round
    };
  }
}

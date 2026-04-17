/**
 * Arena — multi-model collaborative analysis (Evidence-Driven).
 */

export { Arena } from "./arena.js";
export { MODEL_PRESETS, getMaxOutputTokens } from "./model-presets.js";
export type { ModelPreset } from "./model-presets.js";
export { getStrategy, getStrategyForPlan, ReviewStrategy, DiscussionStrategy, PlanningStrategy } from "./strategies/index.js";
export { planArena } from "./planner.js";
export { collectEvidence } from "./providers/index.js";
export { selectTools, hasTools } from "./tools/selector.js";
export { getLens, resolveLenses, buildLensPrompt, LENS_NAMES } from "./lenses/index.js";
export { runParticipantResearch, runParticipantResearchWithDossiers } from "./phases/participant-research.js";
export type { ResearchResult } from "./phases/participant-research.js";
export { runCrossReview, runVerificationReview } from "./phases/cross-review.js";
export { runDebateRounds } from "./phases/debate-rounds.js";
export { runAdjudication } from "./phases/adjudication.js";
export { buildConsensus } from "./phases/build-consensus.js";
export { registerClaims, selectClaimsForReview } from "./phases/claim-registry.js";
export { ArenaLedger } from "./ledger.js";
export { buildDigest, formatDigest } from "./digest-builder.js";
export {
  transitionClaim,
  resolveClaimStatus,
  markUnderReview,
  applyReviewResult,
  markUnresolved,
  isTerminal,
  validTransitions,
} from "./transitions.js";
export { formatArenaResult, printArenaResult, renderProgress, createProgressRenderer } from "./render/terminal.js";
export type { OutputSink } from "./render/terminal.js";
export { formatArenaResultForSession } from "./render/session.js";

export type {
  ArenaConfig,
  ArenaResultV2,
  ArenaStrategy,
  ArenaStrategyV2,
  ClaimStatusSummary,
  ArenaParticipant,
  ArenaBaseContext,
  ArenaFinding,
  FindingReview,
  ParticipantReport,
  ArenaConsensus,
  ArenaConsensusItem,
  ArenaRoadmapPhase,
  ArenaProgressEvent,
  ArenaMode,
  FindingKind,
  PeerVerdict,
  ArenaPlan,
  ArenaLens,
  ArenaLensName,
  ArenaLensRef,
  ArenaSourceKind,
  ArenaSourceSpec,
  ArenaSubject,
  ArenaOutputShape,
  ArenaArtifact,
  ArenaToolPack,
  ArenaContextProvider,
  ArenaQuickFact,
  // Evidence-Driven types
  ToolTrace,
  EvidencePacket,
  FindingEvidenceLink,
  ResearchDossier,
  ClaimStatus,
  ClaimRecord,
  ClaimChallenge,
  ClaimAdjudication,
  RequestedCheck,
  DebateRound,
  DebateTurn,
  TargetedCheckTask,
  SharedResearchLedger,
  RoundResearchDigest,
  ArenaExecutionLimits,
} from "./types.js";
export { isStrategyV2 } from "./types.js";

/**
 * Arena compatibility root.
 *
 * Product hosts should prefer /runtime. The remaining exports expose advanced
 * algorithms and Iterate mode for existing SDK consumers.
 */
export * from "./index.runtime.js";

export {
  getStrategy,
  getStrategyForPlan,
  ReviewStrategy,
  DiscussionStrategy,
  PlanningStrategy,
} from "./strategies/index.js";
export { planArena } from "./planner.js";
export { collectEvidence } from "./providers/index.js";
export { selectTools, hasTools } from "./tools/selector.js";
export { getLens, resolveLenses, buildLensPrompt, LENS_NAMES } from "./lenses/index.js";
export {
  runParticipantResearch,
  runParticipantResearchWithDossiers,
} from "./phases/participant-research.js";
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

export { IterativeArena } from "./iterate/index.js";
export {
  defaultConvergence as defaultIterateConvergence,
  diffRatio as iterateDiffRatio,
  codeFormat as iterateCodeFormat,
  documentFormat as iterateDocumentFormat,
  getFormat as getIterateFormat,
} from "./iterate/index.js";
export type {
  AuthorRotation,
  CheckpointAction,
  CheckpointContext,
  CheckpointFn,
  ConvergenceSignal,
  Critique,
  CritiqueCategory,
  CritiqueEvidence,
  CritiqueSeverity,
  Draft,
  DraftCandidate,
  IterateConfig,
  IterateFormat,
  IterateProgressEvent,
  IterateResult,
  IterateSubject,
  Round,
  StoppedReason,
  FormatPack as IterateFormatPack,
} from "./iterate/index.js";

/**
 * Arena — multi-model collaborative analysis (V2).
 */

export { Arena } from "./arena.js";
export { MODEL_PRESETS, getMaxOutputTokens } from "./model-presets.js";
export type { ModelPreset } from "./model-presets.js";
export { getStrategy, ReviewStrategy, DiscussionStrategy, PlanningStrategy } from "./strategies/index.js";
export { resolveIntent } from "./intent-resolver.js";
export { resolveScope } from "./scope-resolver.js";
export { collectSharedFacts } from "./context/shared-facts.js";
export { runParticipantResearch } from "./phases/participant-research.js";
export { runCrossReview } from "./phases/cross-review.js";
export { buildConsensus } from "./phases/build-consensus.js";
export { formatArenaResult, printArenaResult, renderProgress, createProgressRenderer } from "./render/terminal.js";
export type { OutputSink } from "./render/terminal.js";
export { formatArenaResultForSession } from "./render/session.js";

export type {
  ArenaConfig,
  ArenaResultV2,
  ArenaStrategy,
  ArenaParticipant,
  ArenaIntentSpec,
  ArenaScopeSpec,
  ArenaBaseContext,
  ArenaFinding,
  FindingReview,
  ParticipantReport,
  ArenaConsensus,
  ArenaConsensusItem,
  ArenaProgressEvent,
  ArenaMode,
  FindingKind,
  PeerVerdict,
} from "./types.js";

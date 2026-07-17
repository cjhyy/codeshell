/**
 * Stable host runtime for Arena.
 *
 * This entry intentionally excludes phase/strategy internals and Iterate mode.
 */
export { Arena } from "./arena.js";
export {
  arenaTool,
  arenaToolDef,
  ArenaCapabilitySettingsSchema,
  createArenaCapability,
  getArenaStatus,
  saveArenaSettingsByKeys,
  type ArenaStatus,
} from "./capability.js";
export { MODEL_PRESETS, getMaxOutputTokens } from "./model-presets.js";
export type { ModelPreset } from "./model-presets.js";
export {
  formatArenaResult,
  printArenaResult,
  renderProgress,
  createProgressRenderer,
  type OutputSink,
} from "./render/terminal.js";
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

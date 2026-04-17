/**
 * code-shell — general-purpose agent orchestration framework
 *
 * Public API exports.
 */

export const VERSION = "0.1.0";

// ─── Types ───────────────────────────────────────────────────────

export type {
  Message,
  ContentBlock,
  ToolDefinition,
  ToolCall,
  ToolResult,
  RegisteredTool,
  TranscriptEvent,
  TranscriptEventType,
  SessionState,
  TokenUsage,
  CompiledInput,
  PermissionDecision,
  PermissionMode,
  PermissionRule,
  TurnPhase,
  TurnResult,
  TerminalReason,
  StreamEvent,
  StreamCallback,
  LLMConfig,
  LLMResponse,
  Settings,
  MCPServerConfig,
} from "./types.js";

// ─── Exceptions ──────────────────────────────────────────────────

export {
  FrameworkError,
  LLMError,
  LLMRateLimitError,
  ContextLimitError,
  ToolError,
  ToolNotFoundError,
  ToolExecutionError,
  ToolTimeoutError,
  PermissionDeniedError,
  SessionError,
  TranscriptError,
  ConfigError,
} from "./exceptions.js";

// ─── Engine (primary API) ────────────────────────────────────────

export { Engine } from "./engine/engine.js";
export type { EngineConfig, EngineResult } from "./engine/engine.js";

// ─── LLM ─────────────────────────────────────────────────────────

export { LLMClientBase } from "./llm/client-base.js";
export { createLLMClient, registerProvider } from "./llm/client-factory.js";
export { AnthropicClient } from "./llm/providers/anthropic.js";
export { OpenAIClient } from "./llm/providers/openai.js";
export { ModelPool, type ModelEntry } from "./llm/model-pool.js";

// ─── Tools ───────────────────────────────────────────────────────

export { ToolRegistry } from "./tool-system/registry.js";
export { ToolExecutor } from "./tool-system/executor.js";
export { PermissionClassifier, HeadlessApprovalBackend, AutoApprovalBackend } from "./tool-system/permission.js";
export type { ApprovalBackend } from "./tool-system/permission.js";
export { BUILTIN_TOOLS } from "./tool-system/builtin/index.js";
export { MCPManager } from "./tool-system/mcp-manager.js";
export type { AskUserFn } from "./tool-system/builtin/ask-user.js";
export { taskManager } from "./tool-system/builtin/task.js";
export type { Task, TaskStatus } from "./tool-system/builtin/task.js";

// ─── Hooks ───────────────────────────────────────────────────────

export { HookRegistry } from "./hooks/registry.js";
export type { HookEventName, HookContext, HookResult } from "./hooks/events.js";

// ─── Session ─────────────────────────────────────────────────────

export { Transcript } from "./session/transcript.js";
export { SessionManager } from "./session/session-manager.js";
export { FileHistory } from "./session/file-history.js";
export { MemoryManager } from "./session/memory.js";
export type { MemoryEntry } from "./session/memory.js";
export type { FileSnapshot } from "./session/file-history.js";

// ─── Prompt ──────────────────────────────────────────────────────

export { PromptComposer } from "./prompt/composer.js";
export { SectionCache } from "./prompt/section-cache.js";
export { scanInstructions, combineInstructions } from "./prompt/instruction-scanner.js";

// ─── Presets ─────────────────────────────────────────────────────

export {
  BUILTIN_AGENT_PRESETS,
  DEFAULT_AGENT_PRESET,
  DEFAULT_CLI_PRESET,
  resolveAgentPreset,
  resolveBuiltinToolNames,
  buildPresetSystemPrompt,
  registerPreset,
  listPresetNames,
} from "./preset/index.js";
export type { AgentPreset, AgentPresetName } from "./preset/index.js";
export { loadSection, loadSections, availableSections, registerSection } from "./prompt/section-loader.js";

// ─── Context ─────────────────────────────────────────────────────

export { ContextManager } from "./context/manager.js";
export {
  estimateTokens,
  microcompact,
  windowCompact,
  truncateToolResult,
  buildSummarizationPrompt,
  applySummaryCompaction,
} from "./context/compaction.js";
export type { SummarizeFn } from "./context/manager.js";

// ─── Skills ──────────────────────────────────────────────────────

export { scanSkills, matchSkillsByInput, matchSkillsByTool, buildSkillListing } from "./skills/index.js";
export type { SkillDefinition, MatchResult } from "./skills/index.js";

// ─── Arena ───────────────────────────────────────────────────────

export { Arena } from "./arena/arena.js";
export { MODEL_PRESETS, getMaxOutputTokens } from "./arena/model-presets.js";
export type { ModelPreset } from "./arena/model-presets.js";
export { detectArenaMode } from "./arena/detect-mode.js";
export { getStrategy, getStrategyForPlan, ReviewStrategy, DiscussionStrategy, PlanningStrategy } from "./arena/strategies/index.js";
export { planArena } from "./arena/planner.js";
export { collectEvidence } from "./arena/providers/index.js";
export { selectTools, hasTools } from "./arena/tools/selector.js";
export { ArenaLedger } from "./arena/ledger.js";
export { registerClaims, selectClaimsForReview } from "./arena/phases/claim-registry.js";
export { buildDigest, formatDigest } from "./arena/digest-builder.js";
export { transitionClaim, resolveClaimStatus, markUnderReview, applyReviewResult, markUnresolved, isTerminal, validTransitions } from "./arena/transitions.js";
export type {
  ArenaConfig,
  ArenaMode,
  ArenaResultV2,
  ArenaStrategy,
  ArenaParticipant,
  ArenaBaseContext,
  ArenaFinding,
  FindingReview,
  ParticipantReport,
  ArenaConsensus,
  ArenaConsensusItem,
  ArenaRoadmapPhase,
  ArenaProgressEvent,
  ArenaPlan,
  ArenaLens,
  ArenaLensName,
  ArenaSourceKind,
  ArenaArtifact,
  ArenaQuickFact,
  FindingKind,
  PeerVerdict,
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
} from "./arena/types.js";

// ─── Run (Managed Agent Lifecycle) ──────────────────────────────

export {
  // Manager
  RunManager,
  type RunManagerConfig,
  // Store
  type RunStore,
  FileRunStore,
  // Queue
  RunQueue,
  // Runner
  EngineRunner,
  type EngineRunnerConfig,
  type RunExecutionHandle,
  type RunExecutor,
  type CustomToolEntry,
  // Approval / Input adapters
  RunApprovalBackend,
  createRunAskUserFn,
  type RunLifecycleHooks,
  // Checkpoint & Artifacts
  CheckpointWriter,
  ArtifactTracker,
  // Hardening
  RunLock,
  Heartbeat,
  // Evaluator
  NoopEvaluator,
  CompositeEvaluator,
  type Evaluator,
  type EvaluatorResult,
  type EvaluatorContext,
  // Types
  type RunStatus,
  type RunSnapshot,
  type RunEvent,
  type RunCheckpoint,
  type RunApproval,
  type RunArtifactRef,
  type SubmitRunInput,
  type ResumeRunInput,
  type ListRunsQuery,
  type RunStreamEvent,
  type RunStreamCallback,
  type DetachFn,
  VALID_TRANSITIONS,
  // Factory
  createRunManager,
  type CreateRunManagerOptions,
} from "./run/index.js";

// ─── Product (Domain-Specific Agents) ────────────────────────────

export {
  defineProduct,
  type ProductDefinition,
  type ProductPreset,
  type ProductAdapter,
  type ProductContract,
  type CustomTool,
  type ProductRuntimeOptions,
  type ProductInstance,
} from "./product/index.js";

// ─── Logging ─────────────────────────────────────────────────────

export { logger } from "./logging/logger.js";

// ─── Settings ────────────────────────────────────────────────────

export { SettingsManager } from "./settings/manager.js";
export { SettingsSchema, validateSettings } from "./settings/schema.js";

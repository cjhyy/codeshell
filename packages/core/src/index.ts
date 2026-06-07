/**
 * code-shell — general-purpose agent orchestration framework
 *
 * Public API exports.
 */

export const VERSION = "0.5.0-rc.0";

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
  SessionStatus,
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
  ClientDefaults,
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
  SandboxUnavailableError,
} from "./exceptions.js";

// ─── Engine (primary API) ────────────────────────────────────────

export { Engine, loadAgentDefinitionsForCwd } from "./engine/engine.js";
export type { EngineConfig, EngineHookConfig, EngineResult } from "./engine/engine.js";
export {
  parseAgentDefinition,
  serializeAgentDefinition,
  type AgentDefinition,
} from "./agent/agent-definition.js";
export {
  AgentDefinitionRegistry,
  type AgentSourceDir,
} from "./agent/agent-definition-registry.js";
export type { CostStateStore, CostStateSnapshot } from "./engine/cost-store.js";
export { EngineRuntime } from "./engine/runtime.js";
export type { EngineRuntimeOptions } from "./engine/runtime.js";
export { ChatSessionManager } from "./protocol/chat-session-manager.js";
export type { ChatSessionManagerOptions } from "./protocol/chat-session-manager.js";

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
export type { BuiltinTool, BuiltinToolFn } from "./tool-system/builtin/index.js";
export { makeUpdateAutomationMemoryTool } from "./tool-system/builtin/update-automation-memory.js";
export { MCPManager } from "./tool-system/mcp-manager.js";
export type { AskUserFn } from "./tool-system/builtin/ask-user.js";
// taskManager singleton removed in the TodoWrite refactor; task state
// lives in the transcript now. Type re-exports stay for SDK consumers
// that imported the old `Task` shape.
export type { Task, TaskStatus } from "./tool-system/builtin/task.js";

// ─── Hooks ───────────────────────────────────────────────────────

export { HookRegistry } from "./hooks/registry.js";
export type { HookEventName, HookContext, HookResult } from "./hooks/events.js";
export { wrapHookMessages } from "./hooks/inject.js";

// ─── Protocol (client/server + transports) ──────────────────────

export { AgentServer, type AgentServerOptions } from "./protocol/server.js";
export { AgentClient, type BackgroundAgentCompletedHandler } from "./protocol/client.js";
export {
  createInProcessTransport,
  StdioTransport,
  type Transport,
} from "./protocol/transport.js";
export {
  SocketTransport,
  listenTcp,
  type TcpListenResult,
} from "./protocol/tcp-transport.js";
// Recommended public factories — see protocol/factories.ts for the
// stable construction contract referenced by standard §7.
export {
  createServer,
  createClient,
  type CreateServerOptions,
  type CreateClientOptions,
  type ServerHandle,
} from "./protocol/factories.js";
export {
  Methods,
  ErrorCodes,
  type RpcMessage,
  type RunResult,
} from "./protocol/types.js";

// ─── Session ─────────────────────────────────────────────────────

export { Transcript } from "./session/transcript.js";
export { SessionManager } from "./session/session-manager.js";
export { FileHistory } from "./session/file-history.js";
export { latestUndoTarget } from "./session/undo-target.js";
export { diffLines, renderDiffPreview, type DiffLine } from "./session/simple-diff.js";
export { MemoryManager } from "./session/memory.js";
export type { MemoryEntry, MemoryScope } from "./session/memory.js";
export {
  runDreamConsolidation,
  type DreamConsolidationInput,
  type DreamConsolidationResult,
} from "./services/dream-consolidation.js";
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
  COMPACTABLE_TOOL_NAMES,
} from "./context/compaction.js";
export type { MicrocompactOptions } from "./context/compaction.js";
export type {
  SummarizeFn,
  CompactStrategy,
  OnCompactFn,
  ContextManagerConfig,
} from "./context/manager.js";
export {
  applyToolResultPersistence,
  createContentReplacementState,
  reconstructContentReplacementState,
  resolveToolResultsDir,
  isPersistedReplacement,
  DEFAULT_PERSIST_THRESHOLD,
  PER_MESSAGE_AGGREGATE_CAP,
  PREVIEW_SIZE,
} from "./context/tool-result-storage.js";
export type { ContentReplacementState } from "./context/tool-result-storage.js";

// ─── Skills ──────────────────────────────────────────────────────

export { scanSkills, invalidateSkillCache } from "./skills/index.js";
export type { SkillDefinition } from "./skills/index.js";

// ─── Capability control (扩展能力 backend) ───────────────────────
export {
  CapabilityService,
  CapabilityNotFoundError,
  projectBuiltin,
  projectMcp,
  projectSkills,
  projectPlugins,
} from "./capability-control/index.js";
export type {
  CapabilityServiceDeps,
  CapabilityDescriptor,
  CapabilityControl,
} from "./capability-control/index.js";
export { readInstalledPlugins } from "./plugins/installedPlugins.js";
export type { InstalledPluginsV2 } from "./plugins/types.js";

// ─── Plugin installer (CC + Codex) ───────────────────────────────
export { installPluginFromPath } from "./plugins/installer/install.js";
export { installPluginFromSource } from "./plugins/installer/installFromSource.js";
export { parseSource, type ParsedSource } from "./plugins/installer/parseSource.js";
export { detectPluginFormat } from "./plugins/installer/detectFormat.js";
export {
  CodexPluginManifest,
  CSMeta,
  PluginInstallError,
} from "./plugins/installer/types.js";
export { mergePluginMcpServers } from "./plugins/installer/loadPluginMcp.js";
export { pluginAgentDirs } from "./plugins/installer/loadPluginAgents.js";
export {
  appendInstallEntry,
  pluginInstallKey,
  removeInstallEntries,
} from "./plugins/installedPlugins.js";
export { uninstallPluginByName } from "./plugins/installer/uninstall.js";
export { listInstalledPlugins, type PluginListRow } from "./plugins/installer/list.js";
export { updatePluginByName, type UpdateResult } from "./plugins/installer/update.js";

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

// ─── Arena: Iterate mode ────────────────────────────────────────
// Multi-model authoring loop (tournament v1 → critique-revise rounds).
// Use IterativeArena to produce a draft from scratch (code, PRD, design doc);
// use Arena (above) to review an existing artifact.
export {
  IterativeArena,
  defaultIterateConvergence,
  iterateDiffRatio,
  iterateCodeFormat,
  iterateDocumentFormat,
  getIterateFormat,
} from "./arena/index.js";
export type {
  IterateConfig,
  IterateResult,
  IterateSubject,
  IterateFormat,
  IterateProgressEvent,
  IterateFormatPack,
  Draft,
  DraftCandidate,
  Critique,
  CritiqueCategory,
  CritiqueEvidence,
  CritiqueSeverity,
  ConvergenceSignal,
  Round,
  AuthorRotation,
  StoppedReason,
  CheckpointFn,
  CheckpointContext,
  CheckpointAction,
} from "./arena/index.js";

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
  AUTOMATION_PROMPT_NOTE,
  AUTOMATION_RUN_SOURCE,
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
  type RunLockConfig,
  type RunLockAcquireResult,
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

export { SettingsManager, type SettingsScope } from "./settings/manager.js";
export {
  migrateConfig,
  configVersionOf,
  CURRENT_CONFIG_VERSION,
  type MigrationStep,
} from "./settings/migrate-config.js";
export { SettingsSchema, validateSettings } from "./settings/schema.js";
export { personalizationFrom, type PersonalizationConfig } from "./settings/personalization.js";

// ─── State (runtime singletons shared with TUI) ──────────────────

export {
  getSessionId,
  switchSession,
  getOriginalCwd,
  setOriginalCwd,
  getProjectRoot,
  setProjectRoot,
  getCwdState,
  getIsInteractive,
  updateLastInteractionTime,
  flushInteractionTime,
  markScrollActivity,
  type AttributedCounter,
  type ChannelEntry,
} from "./state.js";

// ─── Utils (shared primitives used by TUI) ───────────────────────

export {
  getGraphemeSegmenter,
  firstGrapheme,
  lastGrapheme,
  getWordSegmenter,
  getRelativeTimeFormat,
  getTimeZone,
  getSystemLocaleLanguage,
} from "./utils/intl.js";

export { env } from "./utils/env.js";
export { default as sliceAnsi } from "./utils/sliceAnsi.js";
export { execFileNoThrow } from "./utils/execFileNoThrow.js";
export { gte } from "./utils/semver.js";
export { logForDebugging } from "./utils/debug.js";
export {
  isEnvTruthy,
  isEnvDefinedFalsy,
  getClaudeConfigHomeDir,
  isBareMode,
  parseEnvVars,
  shouldMaintainProjectWorkingDir,
  isRunningOnHomespace,
  getAWSRegion,
  getDefaultVertexRegion,
  getVertexRegionForModel,
  isInProtectedNamespace,
} from "./utils/envUtils.js";
export {
  startCapturingEarlyInput,
  stopCapturingEarlyInput,
  consumeEarlyInput,
  hasEarlyInput,
  seedEarlyInput,
  isCapturingEarlyInput,
} from "./utils/earlyInput.js";
export {
  formatBytes,
  formatToolArgs,
  singleLine,
  MAX_LINE_WIDTH,
  TOOL_DOT_COLORS,
} from "./utils/toolDisplay.js";
export { formatDuration, formatTokens } from "./utils/format.js";
export {
  getTheme,
  type Theme,
  type ThemeName,
  type ThemeSetting,
} from "./utils/theme.js";
export { resolveThemeSetting, type SystemTheme } from "./utils/systemTheme.js";

// ─── Logging (extended) ──────────────────────────────────────────

export { rotateLogs } from "./logging/logger.js";
export { recordUIEvent } from "./logging/session-recorder.js";

// ─── Cost Tracker ────────────────────────────────────────────────

export { CostTracker, costTracker, installCostTracking } from "./cost-tracker.js";
export { NOOP_COLORIZER, type Colorizer } from "./colorizer.js";

// ─── Onboarding ──────────────────────────────────────────────────

export {
  hasApiKey,
  resolveApiKey,
  appendOnboardingResult,
  detectEnvKeys,
  saveArenaSettingsByKeys,
  type OnboardingResult,
} from "./onboarding.js";

// ─── Updater ─────────────────────────────────────────────────────

export {
  getCurrentVersion,
  checkForUpdate,
  scheduleAutoInstallOnExit,
  getUpdateAvailable,
  getAutoUpdateDisabledReason,
  type UpdateInfo,
} from "./updater.js";

// ─── Git Utilities ───────────────────────────────────────────────

export {
  isGitRepo,
  getCurrentBranch,
  getGitStatus,
  getGitDiff,
  getGitDiffStat,
  getGitLog,
  gitAdd,
  gitCommit,
  gitListBranches,
  gitCheckout,
  ghAvailable,
  ghPrComments,
} from "./git/utils.js";

// ─── Code review (TODO 7.3) ─────────────────────────────────────
export {
  buildReviewPrompt,
  parseDimensions,
  ALL_DIMENSIONS,
  type ReviewDimension,
  type ReviewPromptOptions,
} from "./review/review-prompt.js";

// ─── Tool-system (extended for TUI) ─────────────────────────────

export { getInteractiveApprovalBackend } from "./tool-system/permission.js";
export {
  defaultSandboxConfig,
  type SandboxConfig,
} from "./tool-system/sandbox/index.js";
export {
  buildNotificationMessage,
  buildNotificationSummary,
  notificationQueue,
  agentNotificationBus,
  notificationItemToStreamEvent,
  type NotificationItem,
} from "./tool-system/builtin/agent-notifications.js";
// B2.2 — typed projection of the new `background_agent_completed` StreamEvent
// variant so SDK consumers can write handlers without re-destructuring the
// StreamEvent union themselves.
export type { BackgroundAgentCompletedEvent } from "./types.js";
// Automation — zero-env-dependency scheduling module (startAutomation facade
// + scheduler/store/runner). Hosts (Electron main, future CLI server) load
// this and inject store + runner. See docs/automation-plan-2026-05-31.md.
export {
  startAutomation,
  type StartAutomationDeps,
  type AutomationHandle,
  CronScheduler,
  cronScheduler,
  type CronJob,
  type CronPermissionLevel,
  type CreateJobOptions,
  type UpdateJobPatch,
  CronStore,
  defaultCronStorePath,
  bindCronToEngine,
  bindCronToRunManager,
  type CronRunner,
  type CronRunRequest,
  type CronRunResult,
  type RunSubmitter,
  isCronExpression,
  parseCronExpression,
  nextCronTime,
  type ParsedCron,
  resolveWritePolicy,
  wrapUntrustedInput,
  type WritePolicy,
  runWriteJobInWorktree,
  type WriteJobGitOps,
  type RunWriteJobInput,
  type RunWriteJobResult,
} from "./automation/index.js";
export {
  asyncAgentRegistry,
  type AsyncAgentEntry,
} from "./tool-system/builtin/agent-registry.js";
export {
  backgroundShellManager,
  BackgroundShellManager,
  type BgShell,
  type BgShellStatus,
} from "./runtime/background-shell.js";
export {
  getImageProvider,
  DEFAULT_IMAGE_MODEL,
  type ImageProvider,
  type ImageProviderCreds,
  type ImageGenerateRequest,
  type ImageGenerateResult,
} from "./tool-system/builtin/image-providers.js";

// ─── Protocol (extended for TUI) ────────────────────────────────

export { createInProcessClient } from "./protocol/helpers.js";
// Note: agent-server-stdio.ts is a self-running entry point in the multi-session
// rewrite; the previous named exports (runAgentServerStdio,
// buildEngineConfigFromSettings) were only used in this re-export and have been
// dropped. Hosts spawn the file directly via `node agent-server-stdio.js`.
export type { ProtocolModelEntry } from "./protocol/types.js";

// ─── Arena (extended for TUI) ───────────────────────────────────

export {
  formatArenaResult,
  printArenaResult,
  renderProgress,
  createProgressRenderer,
  type OutputSink,
} from "./arena/render/terminal.js";
export { formatArenaResultForSession } from "./arena/render/session.js";

// ─── Plugins ─────────────────────────────────────────────────────

export {
  installPlugin,
  uninstallPlugin,
  listInstalled,
} from "./plugins/pluginInstaller.js";
export {
  addMarketplace,
  removeMarketplace,
  listMarketplaces,
  loadMarketplace,
} from "./plugins/marketplaceManager.js";
export {
  parseMarketplaceInput,
  deriveMarketplaceName,
} from "./plugins/parseMarketplaceInput.js";
export {
  scanPluginCommands,
  type PluginCommand,
} from "./plugins/pluginCommandsLoader.js";

// ─── LLM (extended for TUI) ─────────────────────────────────────

export {
  type CachedModel,
  defaultCacheDir,
} from "./llm/model-cache.js";
export {
  fetchModelList,
  type FetchResult,
} from "./llm/model-fetcher.js";
export {
  sanitizeApiKey,
  hasNonAsciiPrintable,
} from "./llm/api-key-sanitize.js";
export {
  PROVIDER_KINDS,
  type ProviderKindName,
} from "./llm/provider-kinds.js";
export {
  capabilitiesFor,
  type Capability,
} from "./llm/capabilities/index.js";
export {
  reasoningControlFor,
  type ReasoningControl,
} from "./llm/capabilities/reasoning-control.js";
export {
  REASONING_EFFORTS,
  type ReasoningSetting,
} from "./llm/reasoning-setting.js";
export { type ProviderConfig } from "./llm/provider-catalog.js";

// ─── Data ────────────────────────────────────────────────────────

export {
  syncOpenRouterCatalog,
  getOpenRouterSnapshot,
} from "./data/openrouter-sync.js";

// ─── Types (extended for TUI) ────────────────────────────────────

export type {
  ApprovalRequest,
  ApprovalResult,
  ApprovalScope,
  TaskInfo,
} from "./types.js";

// ─── External agent orchestration (Mobile Web Remote) ────────────
// CLI adapters + config/mode resolution + slash parsing for Claude Code /
// Codex managed jobs. Consumed by the Electron Mobile Web Remote host.

export {
  resolveExternalAgentConfig,
  resolveClaudeModeForWorkspace,
} from "./external-agents/config.js";
export { ExternalAgentJobManager } from "./external-agents/manager.js";
export type { ExternalAgentJobManagerAdapters } from "./external-agents/manager.js";
export {
  ClaudeCodeAdapter,
  buildClaudeCodeSpawn,
} from "./external-agents/adapters/claude-code.js";
export { CodexAdapter } from "./external-agents/adapters/codex.js";
export {
  parseExternalAgentSlash,
  type ParsedExternalAgentSlash,
} from "./external-agents/slash.js";
export type {
  ExternalAgentKind,
  ExternalAgentMode,
  ExternalAgentModeOverride,
  ExternalAgentsSettings,
  ResolvedExternalAgentsConfig,
  ResolvedClaudeCodeSettings,
  ResolvedCodexSettings,
  ClaudeModeDecision,
  ExternalAgentJob,
  ExternalAgentJobStatus,
  ExternalAgentEvent,
  StartExternalAgentJobInput,
  ExternalAgentAdapter,
} from "./external-agents/types.js";

/**
 * code-shell — general-purpose agent orchestration framework
 *
 * Public API exports.
 */

export const VERSION = "0.7.1";

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
  SessionKind,
  SessionWorkspace,
  SessionForkLineage,
  ContextUsageAnchor,
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
export type {
  GoalConfig,
  GoalLifecycleConfig,
  GoalLifecyclePhase,
  GoalLifecycleTerminalReason,
  GoalLifecycleV1,
} from "./goal/lifecycle.js";

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
export type { EngineConfig, EngineHookConfig, EngineResult } from "./engine/types.js";
export type { RunBehaviorMode, RunBehaviorProfile } from "./engine/run-types.js";
export { resolveLLMConfigForTag } from "./engine/resolve-llm-config.js";
export { resolveAuxKey } from "./engine/aux-key.js";
export {
  parseAgentDefinition,
  serializeAgentDefinition,
  type AgentDefinition,
} from "./agent/agent-definition.js";
export { AgentDefinitionRegistry, type AgentSourceDir } from "./agent/agent-definition-registry.js";
export type { CostStateStore, CostStateSnapshot } from "./engine/cost-store.js";
export { EngineRuntime } from "./engine/runtime.js";
export type { EngineRuntimeOptions } from "./engine/runtime.js";
export {
  ChatSessionManager,
  createChatSessionManager,
  LOCAL_CHAT_IDENTITY,
} from "./protocol/chat-session-manager.js";
export type {
  ChatSessionManagerOptions,
  LiveChatSessionSnapshot,
} from "./protocol/chat-session-manager.js";

// ─── LLM ─────────────────────────────────────────────────────────

export { LLMClientBase } from "./llm/client-base.js";
export { createLLMClient, registerProvider } from "./llm/client-factory.js";
export type { CreateMessageOptions } from "./llm/types.js";
export { AnthropicClient } from "./llm/providers/anthropic.js";
export { OpenAIClient } from "./llm/providers/openai.js";
export { ModelPool, type ModelEntry } from "./llm/model-pool.js";
export { modelEntriesFromConnections } from "./engine/model-connections-pool.js";

// ─── Tools ───────────────────────────────────────────────────────

export { ToolRegistry } from "./tool-system/registry.js";
export { ToolExecutor } from "./tool-system/executor.js";
export {
  PermissionClassifier,
  HeadlessApprovalBackend,
  AutoApprovalBackend,
} from "./tool-system/permission.js";
export type { ApprovalBackend } from "./tool-system/permission.js";
export { BUILTIN_TOOLS, derivePresetExposure } from "./tool-system/builtin/index.js";
export type { BuiltinTool, BuiltinToolFn } from "./tool-system/builtin/index.js";
export type { ToolContext } from "./tool-system/context.js";
export type {
  AgentPanelDescriptor,
  PanelHostBridge,
  PanelOpenResult,
} from "./tool-system/panel-bridge.js";
export { fileCache, invalidateFileCache } from "./tool-system/builtin/file-cache.js";
export { validateToolArgs } from "./tool-system/validation.js";
export { createOffBackend } from "./tool-system/sandbox/off.js";

// ─── WorkspaceProfile（数字人）harness 元机制 ─────────────────────
export {
  WorkspaceProfileSchema,
  activateWorkspaceProfile,
  deactivateWorkspaceProfile,
  listWorkspaceProfiles,
  readWorkspaceProfile,
  resolveActiveWorkspaceProfile,
  saveWorkspaceProfile,
  workspaceProfileDir,
  workspaceProfilesRoot,
  type WorkspaceProfile,
  type WorkspaceProfileSubtree,
} from "./profile/index.js";

export {
  createFakeToolContext,
  createToolRegistryHarness,
  type FakeToolContextOptions,
  type ToolRegistryHarness,
  type ToolRegistryHarnessOptions,
} from "./tool-system/testing/tool-registry-harness.js";
export {
  registerCapability,
  unregisterCapability,
  listRegisteredCapabilities,
} from "./capabilities/index.js";
export type {
  CapabilityArtifact,
  CapabilityArtifactDetectionContext,
  CapabilityArtifactDetector,
  CapabilityDynamicContext,
  CapabilityDynamicContextProvider,
  CapabilityFileHistoryContribution,
  CapabilityEngineHookContribution,
  CapabilityInstructionBoundaryFinder,
  CapabilityModule,
  CapabilityToolServiceHost,
  CapabilityToolSelectionContext,
  SessionWorkspaceCapability,
} from "./capabilities/index.js";
export { makeUpdateAutomationMemoryTool } from "./tool-system/builtin/update-automation-memory.js";
export {
  MCPManager,
  buildHttpHeaders,
  buildStdioEnv,
  createMcpAuthenticatedFetch,
} from "./tool-system/mcp-manager.js";
export type { AskUserFn } from "./tool-system/builtin/ask-user.js";
export type {
  ExtensionModule,
  ExtensionQueryHandler,
  ExtensionTool,
  ProtocolLiveSession,
  ProtocolObserver,
  ProtocolObserverHost,
} from "./tool-system/capability-module.js";
export {
  registerExtensionModules,
  queryExtensionModules,
} from "./tool-system/capability-module.js";
// taskManager singleton removed in the TodoWrite refactor; task state
// lives in the transcript now. Type re-exports stay for SDK consumers
// that imported the old `Task` shape.
export type { Task, TaskStatus } from "./tool-system/builtin/task.js";

// ─── Hooks ───────────────────────────────────────────────────────

export { HookRegistry } from "./hooks/registry.js";
export type { HookHandler } from "./hooks/registry.js";
export type { HookEventName, HookContext, HookResult } from "./hooks/events.js";
export { wrapHookMessages } from "./hooks/inject.js";

// ─── Trusted plugin lifecycle ───────────────────────────────────

export { PluginLifecycleRuntime } from "./plugins/runtime.js";
export type {
  PluginLifecycleError,
  PluginLifecycleEvent,
  PluginLifecycleEventName,
  PluginLifecycleHook,
  PluginLifecycleHookContext,
  PluginLifecycleHooks,
  PluginLifecycleModule,
  PluginLifecycleRuntimeOptions,
  PluginPanelInstance,
} from "./plugins/runtime.js";

// ─── Protocol (client/server + transports) ──────────────────────

export { AgentServer, type AgentServerOptions } from "./protocol/server.js";
export { AgentClient, type BackgroundAgentCompletedHandler } from "./protocol/client.js";
export { createInProcessTransport, StdioTransport, type Transport } from "./protocol/transport.js";
export { SocketTransport, listenTcp, type TcpListenResult } from "./protocol/tcp-transport.js";
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
  type ForkSessionParams,
  type ForkSessionResult as ProtocolForkSessionResult,
} from "./protocol/types.js";

// ─── Session ─────────────────────────────────────────────────────

export { Transcript } from "./session/transcript.js";
export {
  SessionManager,
  sessionMainRoot,
  codeShellHome,
  sessionsRoot,
  buildForkState,
  buildForkTranscript,
  type ForkSessionOptions,
  type ForkSessionResult,
} from "./session/session-manager.js";
export { FileHistory } from "./session/file-history.js";
export {
  latestUndoTarget,
  earliestSnapshotsPerFile,
  latestTurnUndoTargets,
  latestRedoTargets,
} from "./session/undo-target.js";
export { diffLines, renderDiffPreview, type DiffLine } from "./session/simple-diff.js";
export { MemoryManager } from "./session/memory.js";
export type { MemoryEntry, MemoryOrigin, MemoryScope } from "./session/memory.js";
export {
  runDreamConsolidation,
  type DreamConsolidationInput,
  type DreamConsolidationResult,
} from "./services/dream-consolidation.js";
export {
  authorize,
  refreshToken,
  generatePKCE,
  createHardenedOAuthFetch,
  type OAuthConfig,
  type OAuthTokens,
  type OAuthAuthorizeOptions,
  type OAuthRefreshOptions,
  type HardenedOAuthFetchOptions,
} from "./services/oauth.js";
export type { FileSnapshot, RedoRecord } from "./session/file-history.js";

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
export {
  loadSection,
  loadSections,
  availableSections,
  registerSection,
} from "./prompt/section-loader.js";

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
export {
  computeEffectiveDisabledLists,
  type EffectiveDisabledLists,
} from "./capability-control/disabled-lists.js";
export type { InstalledPluginsV2 } from "./plugins/types.js";

// ─── Plugin installer (CC + Codex) ───────────────────────────────
export { installPluginFromPath } from "./plugins/installer/install.js";
export { installPluginFromSource } from "./plugins/installer/installFromSource.js";
export {
  installLocalPlugin,
  installPluginFromArchive,
} from "./plugins/installer/installFromArchive.js";
export { parseSource, type ParsedSource } from "./plugins/installer/parseSource.js";
export { detectPluginFormat } from "./plugins/installer/detectFormat.js";
export {
  CodexPluginManifest,
  PluginPanelManifestEntry,
  PluginPanelsManifest,
  CanonicalPluginManifest,
  CANONICAL_PLUGIN_MANIFEST_FILE,
  PLUGIN_PANEL_PERMISSIONS,
  PLUGIN_PANEL_ICONS,
  CSMeta,
  PluginInstallError,
  type PluginPanelManifestEntry as PluginPanelManifestEntryData,
  type PluginPanelsManifest as PluginPanelsManifestData,
  type CanonicalPluginManifest as CanonicalPluginManifestData,
} from "./plugins/installer/types.js";
export {
  normalizePluginManifest,
  readCanonicalPluginManifest,
  type NormalizePluginManifestOptions,
} from "./plugins/installer/normalizeManifest.js";
export { mergePluginMcpServers } from "./plugins/installer/loadPluginMcp.js";
export { pluginsRoot } from "./plugins/installer/paths.js";
export { resolveSafePluginPath } from "./plugins/pluginInstaller.js";
export { listPluginHooks, pluginHookKey, type PluginHookEntry } from "./plugins/loadPluginHooks.js";
export { describePluginContent, type PluginContentInventory } from "./plugins/pluginContent.js";
export {
  loadPluginCatalog,
  loadPluginPanelContributions,
  type LoadPluginCatalogOptions,
  type PluginCatalogEntry,
  type PluginPanelContribution,
} from "./plugins/pluginCatalog.js";
export { pluginAgentDirs } from "./plugins/installer/loadPluginAgents.js";
export {
  appendInstallEntry,
  pluginInstallKey,
  removeInstallEntries,
} from "./plugins/installedPlugins.js";
export { uninstallPluginByName } from "./plugins/installer/uninstall.js";
export { listInstalledPlugins, type PluginListRow } from "./plugins/installer/list.js";
export { updatePluginByName, type UpdateResult } from "./plugins/installer/update.js";
export { checkPluginUpdate, type UpdateCheck } from "./plugins/installer/checkUpdate.js";

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

export { SettingsManager, userHome, type SettingsScope } from "./settings/manager.js";
export {
  migrateConfig,
  configVersionOf,
  CURRENT_CONFIG_VERSION,
  type MigrationStep,
} from "./settings/migrate-config.js";
export { SettingsSchema, validateSettings } from "./settings/schema.js";
export { settingsJsonSchema, writeSettingsSchemaFile } from "./settings/schema-export.js";
export { personalizationFrom, type PersonalizationConfig } from "./settings/personalization.js";
export {
  CredentialStore,
  type CredentialScope,
  type MaskedCredential,
  type Credential,
  type CredentialType,
  type CredentialStoreFile,
  type OAuthCredentialPublicStatus,
  type OAuthCredentialSecret,
  type OAuthTokenResponse,
  buildOAuthRefreshRequest,
  isOAuthAccessTokenExpired,
  oauthCredentialStatus,
  parseOAuthCredentialSecret,
  mergeOAuthTokenResponse,
  shouldRefreshOAuthCredential,
  summarizeOAuthCredentialSecret,
  type OAuthClockOptions,
  type OAuthRefreshHandler,
  type OAuthRefreshRequest,
  formatNetscapeCookies,
  parseCookieJar,
  type CookieLike,
  useCredentialToolDef,
  useCredentialToolDefFor,
  sweepStaleCredentialCookies,
  getCredentialAccess,
  setDefaultCredentialAccess,
  createIpcCredentialAccess,
  localCredentialAccess,
  credentialAccessScope,
  credentialAllowsEnvExposure,
  credentialSecretHint,
  isCredentialSecretAvailable,
  materializeCookieSecret,
  type CredentialAccess,
  type CredentialAccessScope,
  type CredentialMetadata,
  type CredentialSnapshot,
  type CredentialSnapshotEntry,
  type EncryptionCipher,
  PlaintextCipher,
  setDefaultCredentialCipher,
  getDefaultCredentialCipher,
} from "./credentials/index.js";


// ─── Cost Tracker ────────────────────────────────────────────────

export { CostTracker, costTracker, installCostTracking } from "./cost-tracker.js";
export { NOOP_COLORIZER, type Colorizer } from "./colorizer.js";

// ─── Onboarding ──────────────────────────────────────────────────

export {
  hasApiKey,
  resolveApiKey,
  appendOnboardingResult,
  detectEnvKeys,
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



// ─── Plugins ─────────────────────────────────────────────────────

export { installPlugin, uninstallPlugin, listInstalled } from "./plugins/pluginInstaller.js";
export {
  addMarketplace,
  refreshMarketplace,
  removeMarketplace,
  listMarketplaces,
  loadMarketplace,
} from "./plugins/marketplaceManager.js";
export { parseMarketplaceInput, deriveMarketplaceName } from "./plugins/parseMarketplaceInput.js";
export { scanPluginCommands, type PluginCommand } from "./plugins/pluginCommandsLoader.js";


// ─── Data ────────────────────────────────────────────────────────

export { syncOpenRouterCatalog, getOpenRouterSnapshot } from "./data/openrouter-sync.js";


// ─── External agent config (Mobile Web Remote Rooms) ─────────────
// Resolves the externalAgents settings block (notably claudeCode.trustedWorkspaces),
// the source of truth for a Room's permission mode. The former /cc & /codex
// managed-job path was removed — the phone now talks to resident Rooms only.

// ─── Browser automation bridge ───────────────────────────────────
// Driver-agnostic contract + the pure a11y-tree flattener. The desktop host's
// browser-driver module implements BrowserBridge on top of webContents.debugger
// (CDP), reusing flattenAxTree. See the MVP spec
// docs/superpowers/specs/2026-06-16-browser-automation-mvp.md.
export {
  flattenAxTree,
  renderElementList,
  cleanPageText,
  CONTENT_CHAR_CAP,
  buildExtractLinksScript,
  EXTRACT_LINK_CAP,
} from "./tool-system/browser-bridge.js";
export type {
  BrowserBridge,
  BrowserElement,
  BrowserSnapshot,
  BrowserResult,
  BrowserContent,
  BrowserExtract,
  BrowserLink,
  BrowserImage,
  BrowserVideo,
  BrowserImageData,
  BrowserTab,
  AXNode,
} from "./tool-system/browser-bridge.js";
export type { WorkspaceBridge } from "./tool-system/workspace-bridge.js";

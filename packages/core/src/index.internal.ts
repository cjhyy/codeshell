/**
 * Internal host API for the in-repo TUI and desktop applications.
 *
 * This subpath is published so repository hosts can avoid private deep imports,
 * but it is not a stable SDK or semver compatibility contract. External SDK
 * consumers should import from `@cjhyy/code-shell-core` instead.
 */

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
export {
  findExecutable,
  resolveExecutable,
  setGitPathOverride,
  resolveGit,
  isGitAvailable,
  resolveGitPath,
} from "./utils/exec.js";
export { gte } from "./utils/semver.js";
export { lock, lockSync, unlock, check } from "./utils/lockfile.js";
export { logForDebugging } from "./utils/debug.js";
export {
  isEnvTruthy,
  isEnvDefinedFalsy,
  getClaudeConfigHomeDir,
  isBareMode,
  parseEnvVars,
  shouldMaintainProjectWorkingDir,
  getAWSRegion,
  getDefaultVertexRegion,
  getVertexRegionForModel,
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
export {
  classifyBashLines,
  type BashLineKind,
  type ClassifiedBashLine,
} from "./tool-system/builtin/bash-output-style.js";
export { formatDuration, formatTokens } from "./utils/format.js";
export { getTheme, type Theme, type ThemeName, type ThemeSetting } from "./utils/theme.js";
export { resolveThemeSetting, type SystemTheme } from "./utils/systemTheme.js";

// ─── Logging (host lifecycle) ────────────────────────────────────

export { rotateLogs } from "./logging/logger.js";
export { recordUIEvent } from "./logging/session-recorder.js";

// ─── Tool system and host services ───────────────────────────────

export { getInteractiveApprovalBackend } from "./tool-system/permission.js";
export { defaultSandboxConfig, type SandboxConfig } from "./tool-system/sandbox/index.js";
export {
  buildNotificationMessage,
  buildNotificationSummary,
  notificationQueue,
  agentNotificationBus,
  notificationItemToStreamEvent,
  type NotificationItem,
} from "./tool-system/builtin/agent-notifications.js";
export type { BackgroundAgentCompletedEvent } from "./types.js";
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
export { asyncAgentRegistry, type AsyncAgentEntry } from "./tool-system/builtin/agent-registry.js";
export {
  backgroundShellManager,
  BackgroundShellManager,
  type BgShell,
  type BgShellStatus,
} from "./runtime/background-shell.js";
export { ENV_DENY_REGEX, ENV_ALLOWLIST } from "./runtime/spawn-common.js";
export {
  getImageProvider,
  DEFAULT_IMAGE_MODEL,
  type ImageProvider,
  type ImageProviderCreds,
  type ImageGenerateRequest,
  type ImageGenerateResult,
} from "./tool-system/builtin/image-providers.js";
export {
  transcribe,
  type TranscribeCreds,
  type TranscribeRequest,
  type TranscribeResult,
} from "./stt/transcribe.js";
export {
  resolveTranscribeProvider,
  isTranscribeAvailable,
  describeTranscribe,
  type ResolvedTranscribeProvider,
  type TranscribeDescription,
} from "./stt/resolve-transcribe.js";
export {
  BUILTIN_CATALOG,
  getMergedCatalog,
  loadUserCatalog,
  userCatalogPath,
  findCatalogEntry,
  saveCatalogEntry,
  deleteUserCatalogEntry,
  catalogEntryOrigins,
  type CatalogEntry,
} from "./model-catalog/index.js";

// ─── Protocol extensions ─────────────────────────────────────────

export { createInProcessClient } from "./protocol/helpers.js";
export type { ProtocolModelEntry } from "./protocol/types.js";

// ─── LLM host extensions ─────────────────────────────────────────

export { type CachedModel, defaultCacheDir } from "./llm/model-cache.js";
export { fetchModelList, type FetchResult } from "./llm/model-fetcher.js";
export { sanitizeApiKey, hasNonAsciiPrintable } from "./llm/api-key-sanitize.js";
export { PROVIDER_KINDS, type ProviderKindName } from "./llm/provider-kinds.js";
export { capabilitiesFor, type Capability } from "./llm/capabilities/index.js";
export {
  reasoningControlFor,
  type ReasoningControl,
} from "./llm/capabilities/reasoning-control.js";
export { REASONING_EFFORTS, type ReasoningSetting } from "./llm/reasoning-setting.js";
export { type ProviderConfig } from "./llm/provider-catalog.js";

// ─── Extended host types ─────────────────────────────────────────

export type { ApprovalRequest, ApprovalResult, ApprovalScope, TaskInfo } from "./types.js";
export { fileCache } from "./tool-system/builtin/file-cache.js";
export { validateToolArgs } from "./tool-system/validation.js";
export { createOffBackend } from "./tool-system/sandbox/off.js";
export {
  createFakeToolContext,
  createToolRegistryHarness,
  type FakeToolContextOptions,
  type ToolRegistryHarness,
  type ToolRegistryHarnessOptions,
} from "./tool-system/testing/tool-registry-harness.js";

// ─── Sources / WorkspaceProfile host surface (desktop main) ─────

export {
  sourceCatalogPath,
  listSourceDefinitions,
  readSourceDefinition,
  saveSourceDefinition,
  deleteSourceDefinition,
} from "./sources/catalog.js";
export { registerConnectorAdapter, connectorAdapterFor } from "./sources/adapter.js";
export { mockAdapter } from "./sources/adapters/mock.js";
export {
  LOCAL_FILES_SOURCE_ID,
  uploadsDir,
  localFilesSourceFor,
  resolveUploadTarget,
  localFilesAdapter,
  listLocalFiles,
} from "./sources/adapters/local-files.js";
export {
  createMcpResourceAdapter,
  defaultMcpResourceAdapter,
} from "./sources/adapters/mcp-resource.js";
export { listBindings, bindSource, unbindSource } from "./sources/binding.js";
export { resolveEffectiveSourceAccess } from "./sources/resolve.js";
export { defaultCredentialStatus } from "./sources/credential-status.js";
export { buildSourcesContextSummary } from "./sources/context-summary.js";
export {
  listWorkspaceProfiles,
  readWorkspaceProfile,
  saveWorkspaceProfile,
  workspaceProfileDir,
  workspaceProfilesRoot,
} from "./profile/store.js";
export {
  activateWorkspaceProfile,
  deactivateWorkspaceProfile,
  profileOverridesFromDefinition,
} from "./profile/activation.js";
export { resolveActiveWorkspaceProfile, workspaceProfilePresetFor } from "./profile/resolve.js";
export { CapabilityService } from "./capability-control/service.js";
export { CapabilityNotFoundError } from "./capability-control/types.js";
export {
  projectBuiltin,
  projectMcp,
  projectSkills,
  projectPlugins,
} from "./capability-control/project.js";
export { computeEffectiveDisabledLists } from "./capability-control/disabled-lists.js";

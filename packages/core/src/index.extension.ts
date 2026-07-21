/**
 * Stable extension contract for trusted in-process capability packages.
 * Product capabilities depend on this narrow entry instead of private core
 * paths, keeping the package graph one-way: capability -> core.
 */

export type {
  ClientDefaults,
  ContentBlock,
  LLMConfig,
  LLMResponse,
  Message,
  RegisteredTool,
  SessionOrigin,
  SessionStatus,
  StreamEvent,
  TerminalReason,
  TurnCompletionKind,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from "./types.js";
export type { PendingApprovalMetadata } from "./protocol/types.js";
export type { CreateMessageOptions } from "./llm/types.js";
export { LLMClientBase } from "./llm/client-base.js";
export { createLLMClient, registerProvider } from "./llm/client-factory.js";
export { ModelPool, type ModelEntry } from "./llm/model-pool.js";
export { logger } from "./logging/logger.js";
export { addTokenUsage } from "./session/usage.js";
export { resolveMaxOutput } from "./onboarding.js";
export { SettingsManager, userHome } from "./settings/manager.js";
export { NOOP_COLORIZER, type Colorizer } from "./colorizer.js";
export type { ToolContext } from "./tool-system/context.js";
export { webSearchTool } from "./tool-system/builtin/web-search.js";
export { webFetchTool } from "./tool-system/builtin/web-fetch.js";
export { extractJSON, extractJSONArray } from "./utils/json.js";
export type {
  ExtensionModule,
  ExtensionQueryHandler,
  ExtensionTool,
} from "./tool-system/capability-module.js";

// ─── Capability-package composition contract ─────────────────────
// Symbols required by in-process capability packages (currently
// packages/coding) so they can compose against core without importing
// the root barrel or private paths. Each re-export below points at the
// exact same source module as the root index.ts export, so both entries
// resolve to a single module instance (notificationQueue and
// backgroundJobRegistry are process-level singletons — identity must
// stay consistent across entry points).
export type { SessionWorkspace } from "./types.js";
export { registerCapability } from "./capabilities/index.js";
export type {
  CapabilityArtifactDetector,
  CapabilityDynamicContextProvider,
  CapabilityModule,
  CapabilityToolServiceHost,
} from "./capabilities/index.js";
export { BUILTIN_AGENT_PRESETS } from "./preset/index.js";
export type { AgentPreset } from "./preset/index.js";
export { BUILTIN_TOOLS, derivePresetExposure } from "./tool-system/builtin/index.js";
export type { BuiltinTool } from "./tool-system/builtin/index.js";
export { SessionManager, codeShellHome } from "./session/session-manager.js";
export { invalidateFileCache } from "./tool-system/builtin/file-cache.js";
export { notificationQueue } from "./tool-system/builtin/agent-notifications.js";
export { resolveExecutable, resolveGit } from "./utils/exec.js";
export { safeSpawnShell } from "./runtime/safe-spawn.js";
export {
  buildSandboxEnv,
  defaultShellBinary,
  killChildTree,
  killProcessGroup,
  mergeShellEnv,
} from "./runtime/spawn-common.js";
export { isExistingDirectory, normalizeCwdPath } from "./utils/cwd-normalize.js";
export {
  backgroundJobRegistry,
  type BackgroundJobEntry,
} from "./tool-system/builtin/background-jobs.js";
export type { SandboxBackend } from "./tool-system/sandbox/index.js";

// ── Extension seams for out-of-core product capabilities (pet, …) ────
// Behavior profiles, protocol observers and full-metadata catalog tools let a
// capability package own a product domain end-to-end while core stays
// domain-agnostic.
export type { RunBehaviorProfile } from "./engine/run-types.js";
export type {
  ProtocolLiveSession,
  ProtocolObserver,
  ProtocolObserverHost,
} from "./tool-system/capability-module.js";
export type { ToolVisibilityContext } from "./tool-system/context.js";
export type { BuiltinToolExposure } from "./tool-system/builtin/index.js";
export type { PermissionRule, PermissionMode } from "./types.js";
export { ApprovalRouter } from "./tool-system/permission.js";

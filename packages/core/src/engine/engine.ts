/**
 * Engine — the main facade that wires all components together.
 */

import type {
  ClientDefaults,
  Message,
  LLMConfig,
  Settings,
  SessionOrigin,
  StreamCallback,
  TaskInfo,
  TerminalReason,
  TokenUsage,
} from "../types.js";
import { createLLMClient } from "../llm/client-factory.js";
import { ToolRegistry } from "../tool-system/registry.js";
import { ToolExecutor } from "../tool-system/executor.js";
import { InvestigationGuard } from "../tool-system/investigation-guard.js";
import { TaskGuard } from "../tool-system/task-guard.js";
import { readLastTodoSnapshot } from "../tool-system/builtin/task.js";
import { applyDynamicToolDef } from "./dynamic-tool-defs.js";
import { getMergedCatalog } from "../model-catalog/index.js";
import { modelEntriesFromConnections } from "./model-connections-pool.js";
import { resolveAuxKey } from "./aux-key.js";
import { resolveSandboxConfig, type SettingsSandbox } from "./sandbox-config.js";
import { sandboxCacheKey } from "./sandbox-cache-key.js";
import { BUILTIN_TOOL_GUARDS, type BuiltinToolFn } from "../tool-system/builtin/index.js";
import { asyncAgentRegistry } from "../tool-system/builtin/agent-registry.js";
import { backgroundShellManager } from "../runtime/background-shell.js";
import {
  notificationQueue,
  buildNotificationMessage,
  type NotificationItem,
} from "../tool-system/builtin/agent-notifications.js";
import {
  PermissionClassifier,
  HeadlessApprovalBackend,
  AutoApprovalBackend,
  InteractiveApprovalBackend,
  getInteractiveApprovalBackend,
  type ApprovalBackend,
} from "../tool-system/permission.js";
import { HookRegistry } from "../hooks/registry.js";
import type { HookEventName, HookResult } from "../hooks/events.js";
import type { HookHandler } from "../hooks/registry.js";
import { wrapHookMessages } from "../hooks/inject.js";
import { createGoalStopHook } from "../hooks/goal-stop-hook.js";
import {
  normalizeGoal,
  resolveMaxTurns,
  resolveMaxStopBlocks,
  type GoalConfig,
  type GoalExtension,
} from "./goal.js";
import { loadPluginHooks } from "../plugins/loadPluginHooks.js";
import { pluginAgentDirs } from "../plugins/installer/loadPluginAgents.js";
import { patchOrphanedToolUses } from "./patch-orphaned-tools.js";
import { runShellHook, shellHookMatches } from "../hooks/shell-runner.js";
import { ContextManager } from "../context/manager.js";
import {
  estimateTokens,
  clampContextRatios as clampContextRatiosImpl,
} from "../context/compaction.js";
import { PLAN_MODE_ALLOWED_TOOLS } from "../tool-system/plan-mode-allowlist.js";
import { PromptComposer } from "../prompt/composer.js";
import { SessionManager, type SessionBundle } from "../session/session-manager.js";
import { Transcript } from "../session/transcript.js";
import { ModelFacade } from "./model-facade.js";
import type { CostStateStore } from "./cost-store.js";
import { logger, setCurrentSid, runWithSid, getCurrentSid } from "../logging/logger.js";
import { recordSessionStart, recordSessionEnd } from "../logging/session-recorder.js";
import { sanitizeContent, sanitizeTaskString } from "../logging/sanitize-messages.js";
import { TurnLoop, type TurnLoopConfig } from "./turn-loop.js";
import type { AskUserFn } from "../tool-system/builtin/ask-user.js";
import { MCPManager } from "../tool-system/mcp-manager.js";
import { SettingsManager, userHome, noRepoDir, type SettingsScope } from "../settings/manager.js";
import type { CapabilityOverride, CapabilityOverrides } from "../settings/schema.js";
import {
  isFeatureEnabled,
  resolveFeatureFlags,
  type FeatureFlagName,
  type FeatureFlagOverrides,
} from "../settings/feature-flags.js";
import {
  effectiveDisabledList,
  effectiveBuiltinLists,
  whitelistDisabledList,
} from "../capability-control/overlay.js";
import { scanSkills } from "../skills/scanner.js";
import { readInstalledPlugins } from "../plugins/installedPlugins.js";
import { computeEffectiveDisabledLists } from "../capability-control/disabled-lists.js";
import { FileHistory } from "../session/file-history.js";
import { patchBackupTargets } from "../tool-system/builtin/apply-patch/backup-targets.js";
import type { ToolContext, SubAgentSpawner } from "../tool-system/context.js";
import {
  defaultSandboxConfig,
  resolveSandboxBackend,
  type SandboxBackend,
  type SandboxConfig,
} from "../tool-system/sandbox/index.js";
import {
  resolveAgentPreset,
  resolveBuiltinToolNames,
  type AgentPreset,
  type AgentPresetName,
} from "../preset/index.js";
import { ModelPool, type ModelEntry } from "../llm/model-pool.js";
import { AgentDefinitionRegistry } from "../agent/agent-definition-registry.js";
import { ProviderCatalog } from "../llm/provider-catalog.js";
import { defaultCacheDir } from "../llm/model-cache.js";
import {
  detectProviderFromApiKey,
  buildModelPool,
} from "../onboarding.js";
import { detectPastedNoise } from "../utils/task-sanitizer.js";
import {
  parseTaskWithImages,
  ImageParseError,
  type ParsedTask,
} from "./parse-task.js";
import {
  enforceImagePolicy,
  byteLengthFromBase64,
  dropOversizedImages,
  collectAttachedImagePaths,
} from "./image-policy.js";
import { tryCompressImages } from "./image-compression.js";
import { buildSessionTitle } from "./session-title.js";
import { capabilitiesFor } from "../llm/capabilities/index.js";
import type { ProviderKindName } from "../llm/provider-kinds.js";
import type { ContentBlock } from "../types.js";
import { MemoryOrchestrator } from "../services/memory-orchestrator.js";
import { runDreamConsolidation } from "../services/dream-consolidation.js";
import { EngineRuntime } from "./runtime.js";
import { join, isAbsolute } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

/**
 * Build ScanOptions.compatFileNames from the user's instruction compat toggles.
 * Primary file name stays hard-wired to CODESHELL.md (not exposed). Turning a
 * compat flag off only drops the same-named .md (CLAUDE.md / AGENTS.md); the
 * .claude/ subdir, *.local.md and rules/ are intentionally NOT linked.
 * undefined (instructions omitted) means both stay on — backward compatible.
 */
export function compatFileNamesFrom(instructions?: { compatClaude?: boolean; compatCodex?: boolean }): string[] {
  const names: string[] = [];
  if (instructions?.compatClaude !== false) names.push("CLAUDE.md");
  if (instructions?.compatCodex !== false) names.push("AGENTS.md");
  return names;
}

/**
 * True when two LLMConfigs name the SAME client identity — i.e. building a
 * client from either would talk to the same model on the same endpoint with the
 * same shaping. Used by resolveAuxClient to de-dup the aux client against the
 * active model WITHOUT collapsing two distinct pool keys that merely share a
 * `model` NAME but differ in reasoning/maxTokens/baseUrl/provider. Compares the
 * fields that actually change request behavior; apiKey is intentionally NOT
 * compared (two keys with the same endpoint+model but different credentials
 * still produce equivalent aux work and don't warrant a second client). The
 * reasoning object is compared by normalized JSON since it's a small
 * discriminated union.
 */
function sameLlmIdentity(a: LLMConfig, b: LLMConfig): boolean {
  return (
    a.model === b.model &&
    (a.baseUrl ?? undefined) === (b.baseUrl ?? undefined) &&
    (a.provider ?? undefined) === (b.provider ?? undefined) &&
    (a.providerKind ?? undefined) === (b.providerKind ?? undefined) &&
    (a.maxTokens ?? undefined) === (b.maxTokens ?? undefined) &&
    JSON.stringify(a.reasoning ?? null) === JSON.stringify(b.reasoning ?? null)
  );
}

export interface EngineConfig {
  llm: LLMConfig;
  /**
   * Cross-model runtime knobs (temperature/timeout/retryMaxAttempts/imageDetail).
   * Stays stable across hot model switches — only `llm` rotates. When omitted,
   * Engine reads settings.json (model.temperature, images.detail) on construction.
   */
  clientDefaults?: ClientDefaults;
  cwd?: string;
  maxTurns?: number;
  /**
   * Override the goal-mode consecutive-stop-block cap (TODO 3.1). Falls back to
   * goal.maxStopBlocks, then GOAL_DEFAULT_MAX_STOP_BLOCKS. See resolveMaxStopBlocks.
   */
  maxStopBlocks?: number;
  maxToolCallsPerTurn?: number;
  permissionMode?: "default" | "acceptEdits" | "dontAsk" | "bypassPermissions" | "auto" | "plan";
  preset?: AgentPresetName;
  enabledBuiltinTools?: string[];
  disabledBuiltinTools?: string[];
  /**
   * When false, `Bash(run_in_background=true)` is rejected and the
   * background-shell tools are disabled (design §5.5). Set false by
   * unattended automation/cron hosts — no one is there to reap a long-lived
   * dev server. Defaults to true (interactive sessions allow it).
   */
  allowBackgroundShells?: boolean;
  customSystemPrompt?: string;
  appendSystemPrompt?: string;
  responseLanguage?: string;
  userProfile?: string;
  instructions?: { compatClaude?: boolean; compatCodex?: boolean };
  /**
   * Goal mode: when set, the engine registers a GoalStopHook on `on_stop`
   * so the turn loop runs until the session model judges this goal met
   * (bounded by maxStopBlocks + maxTurns). Orthogonal to permissionMode —
   * the desktop UI defaults permission to bypass when a goal is set, but
   * the engine treats the two independently.
   *
   * Accepts a raw string (objective only) or a full GoalConfig (objective +
   * optional token/time budgets); the run boundary normalizes it once.
   */
  goal?: string | GoalConfig;
  sessionStorageDir?: string;
  maxContextTokens?: number;
  approvalBackend?: ApprovalBackend;
  hooks?: EngineHookConfig[];
  askUser?: AskUserFn;
  /** Browser automation bridge (browser_* tools). Wired by the host (desktop)
   *  after construction via setBrowserBridge. Undefined → tools degrade. */
  browserBridge?: import("../tool-system/browser-bridge.js").BrowserBridge;
  /** Inject a cookie credential into the built-in browser (InjectCredential
   *  tool). Wired by the host after construction via setInjectCredential.
   *  Undefined → the tool degrades with a clear "no browser" error. */
  injectCredentialToBrowser?: import("../tool-system/context.js").InjectCredentialFn;
  mcpServers?: Record<string, import("../types.js").MCPServerConfig>;
  /**
   * Optional opaque store for per-session cost/usage state. When provided,
   * Engine calls `restore()` on session resume and `serialize()` at the end
   * of each `run()` and stores the blob on the session. Without this the
   * Engine doesn't persist cost state — it's a UI concern.
   */
  costStore?: CostStateStore;
  /**
   * True when the Engine runs in a no-UI / one-shot context (e.g. the `run`
   * command). Currently controls InvestigationGuard soft-mode: in headless
   * we never hard-block a tool call because there is no human to retry.
   * Defaults to false.
   */
  headless?: boolean;
  /**
   * When true, treat like headless for InvestigationGuard soft-mode — a
   * read-only session should never be hard-blocked for repeated reads.
   */
  readOnlySession?: boolean;
  /**
   * Sandbox configuration for shell-tool execution. When omitted, headless
   * runs default to "auto" (Seatbelt on macOS / bwrap on Linux when
   * available) and interactive runs default to "off" because a human is in
   * the loop to approve commands.
   */
  sandbox?: SandboxConfig;
  /**
   * True when this Engine is itself a sub-agent (spawned by another
   * Engine's Agent tool). Threaded into ToolContext so the Agent tool can
   * refuse re-entry — defense in depth against the tool-list strip in
   * spawn(): if a tool registry regression ever leaks Agent into a child's
   * pool, the runtime check still blocks the call.
   */
  isSubAgent?: boolean;
  /**
   * Hard skill isolation for a sub-agent. When set, this Engine only lists
   * and invokes skills in this allowlist (applied on top of disabledSkills).
   * Set by the spawn() closure from the role definition's `skills:`
   * frontmatter. Undefined → inherit the parent's full skill pool.
   */
  skillAllowlist?: string[];
  /**
   * Host/context that created this Engine's sessions — written to state.json's
   * `origin` so the desktop disk-rebuild can filter the sidebar (desktop +
   * automation shown; tui hidden). Sub-agents override to "subagent".
   */
  origin?: SessionOrigin;
  /**
   * Optional shared EngineRuntime providing pre-constructed shared resources
   * (modelPool, toolRegistry, etc.). When provided, Engine uses these instead
   * of constructing its own. Existing callers that omit this field continue to
   * work unchanged — T11 will migrate them.
   */
  runtime?: EngineRuntime;
  /**
   * Which disk config layers this Engine may read. Defaults to 'project' —
   * the safe default: a library/SDK embedding never silently inherits the
   * host user's personal ~/.code-shell config (keys, models, MCP, hooks); it
   * only reads the project-level ${cwd}/.code-shell that travels with a repo.
   * Host-terminal entrypoints (TUI/desktop/CLI) pass 'full' to restore the
   * managed+user+project+local behavior. 'isolated' reads no disk at all.
   * Subagents inherit the parent Engine's scope. See SettingsScope.
   */
  settingsScope?: SettingsScope;
}

// Re-export the config hot-reload patch builder from here so the protocol
// server (and tests) can import it alongside Engine without reaching into the
// settings/ subtree directly. The implementation lives in settings/ to keep
// engine.ts from growing and to sit next to personalizationFrom it composes.
export { diskDefaultsFrom, type DiskDefaultPatch } from "../settings/disk-defaults.js";

export interface EngineHookConfig {
  event: HookEventName;
  handler: HookHandler;
  priority?: number;
  name?: string;
}

export interface EngineResult {
  text: string;
  reason: TerminalReason;
  sessionId: string;
  turnCount: number;
  usage: TokenUsage;
}

/**
 * Resolve the LLM config for a spawned child Engine.
 * - `modelKey` set + present in pool → that model's config (pure entry-derived
 *   identity; the parent's llm is NOT consulted).
 * - otherwise (no key, no pool, or key miss) → the parent's llm unchanged.
 * Key miss is a soft fallback, NOT an error: a stale agent definition must not
 * crash the spawn.
 *
 * ClientDefaults (temperature/timeout/etc.) are inherited from the parent
 * Engine directly via EngineConfig.clientDefaults — they do not flow through
 * this helper because they're not part of LLMConfig anymore.
 */
export function resolveChildLlm(
  modelKey: string | undefined,
  pool: ModelPool | undefined,
  parentLlm: LLMConfig,
): LLMConfig {
  if (modelKey && pool?.has(modelKey)) {
    const resolved = pool.resolveLLMConfig(modelKey);
    if (resolved) return resolved;
  }
  return parentLlm;
}

/**
 * Load reusable sub-agent role definitions, merging:
 *   1. project-level  <cwd>/.code-shell/agents/*.md   (ships built-ins)
 *   2. user-level     ~/.code-shell/agents/*.md        (user wins on name)
 * Names in `disabledAgents` are filtered out so the LLM never sees them.
 */
/**
 * Resolve the working directory for a run. Precedence:
 *   options.cwd  >  resumed session's state.cwd  >  config.cwd  >  process.cwd()
 *
 * The session-cwd tier is what stops a project-bound session from being
 * resumed against the wrong directory: when a host omits options.cwd (e.g. its
 * sidebar repo selection drifted to null), the session's own recorded cwd is
 * recovered so the engine still loads THAT project's agents/settings/memory,
 * not whatever process.cwd() happens to be. Pure so the precedence is testable
 * without standing up an Engine.
 */
export function resolveRunCwd(args: {
  optionCwd?: string;
  sessionCwd?: string;
  configCwd?: string;
  processCwd: string;
}): string {
  return args.optionCwd ?? args.sessionCwd ?? args.configCwd ?? args.processCwd;
}

export function loadAgentDefinitionsForCwd(
  cwd: string,
  disabledAgents: string[] = [],
  disabledPlugins: string[] = [],
): AgentDefinitionRegistry {
  // userHome() (not raw homedir(), which bun caches at process start and never
  // re-reads) so the user-agents dir honors a test's process.env.HOME override
  // and stays consistent with the rest of the codebase's home resolution.
  const home = userHome();
  // Increasing priority; loadFromDirs is last-dir-wins. ORDER ENCODES POLICY:
  // user (cross-project personal default, lowest) → plugins (reusable baseline)
  // → project (highest). A repo's in-tree agent therefore overrides a same-named
  // user agent. This REVERSES the previous user>project behavior (spec §7.2);
  // the descriptor's shadowedSources surfaces the override so the UI can warn.
  return AgentDefinitionRegistry.loadFromDirs(
    [
      { dir: `${home}/.code-shell/agents`, source: "user" },
      ...pluginAgentDirs(disabledPlugins),
      // No project context (no-project bucket): cwd is "". Skip the project
      // source rather than synthesizing "/.code-shell/agents" at the FS root,
      // which silently resolves to nothing and drops every project-level
      // (built-in) agent from the list.
      ...(cwd ? [{ dir: `${cwd}/.code-shell/agents`, source: "project" as const }] : []),
    ],
    disabledAgents,
  );
}

const NESTED_AGENT_TOOLS = ["Agent", "AgentStatus", "AgentCancel"];

/**
 * #7: apply a project's per-turn builtin capability override to a tool list.
 * A builtin marked `off` for the current cwd is HIDDEN from the turn's tool
 * list (matching how skills/plugins/agents `off` apply mid-session). `on` /
 * `inherit` / absent keep the tool — we can't re-add a tool the ctor-frozen
 * registry omitted, but `on` for a tool already present is a no-op. Pure +
 * exported so it's unit-testable without a full run() turn.
 */
export function applyBuiltinOverrideVisibility<T extends { name: string }>(
  tools: T[],
  override: Record<string, CapabilityOverride> | undefined,
): T[] {
  if (!override) return tools;
  return tools.filter((t) => override[t.name] !== "off");
}

/**
 * Compute a child Engine's tool scope.
 * - `allowlist` set → child enabled = allowlist minus nested-agent tools
 *   (a per-role tool whitelist, e.g. a read-only researcher).
 * - `allowlist` undefined → inherit parent enabled/disabled, always with the
 *   nested-agent tools forced into `disabled` (no grandchildren).
 */
export function resolveChildToolScope(
  allowlist: string[] | undefined,
  parentDisabled: string[] | undefined,
  parentEnabled: string[] | undefined,
): { enabled?: string[]; disabled: string[] } {
  if (allowlist) {
    return {
      enabled: allowlist.filter((t) => !NESTED_AGENT_TOOLS.includes(t)),
      disabled: [...NESTED_AGENT_TOOLS],
    };
  }
  const disabled = Array.from(new Set([...(parentDisabled ?? []), ...NESTED_AGENT_TOOLS]));
  const enabled = parentEnabled?.filter((t) => !NESTED_AGENT_TOOLS.includes(t));
  return { enabled, disabled };
}

export class Engine {
  // Resolved per-session preset. Set in the ctor; re-resolved by
  // refreshRuntimeConfig on a preset hot-reload so the next-turn PromptComposer
  // picks up the new preset's system prompt / behavior (#2). NOT readonly for
  // that reason. NOTE: the toolRegistry's builtin tool SET is still ctor-frozen
  // and is NOT rebuilt on reload — a preset change that alters the builtin tool
  // set only takes effect on session restart (logged in refreshRuntimeConfig).
  private preset: AgentPreset;
  private toolRegistry: ToolRegistry;
  private hooks: HookRegistry;
  private sessionManager: SessionManager;
  private mcpManager: MCPManager | undefined;
  private modelPool: ModelPool;
  /**
   * Handles for the settings-sourced hook handlers registered by
   * registerSettingsHooks(), so reloadHooks() can unregister exactly those
   * (and nothing else — plugin hooks, goal/builtin hooks are untouched) before
   * re-registering from fresh settings. Without this, a reload would
   * accumulate duplicate settings-hook handlers that all fire per event.
   */
  private settingsHookHandles: Array<{ event: HookEventName; handler: HookHandler }> = [];
  /**
   * Highest config-reload version applied so far. refreshRuntimeConfig drops
   * any payload whose version is <= this, so out-of-order reload deliveries
   * (multiple quick settings saves) can't let an older config clobber a newer
   * one.
   */
  private lastAppliedConfigVersion = 0;
  /** Memoized sub-agent role registry, keyed by the cwd it was loaded from. */
  private agentDefsCache?: { cwd: string; disabledKey: string; reg: AgentDefinitionRegistry };

  /** Shared resources supplied at construction (adapter pattern — null when self-constructed). */
  readonly runtime: EngineRuntime | null;
  private readonly sandboxCache = new Map<string, Promise<SandboxBackend>>();
  /** Active permission mode for this Engine instance. */
  permissionMode: NonNullable<EngineConfig["permissionMode"]>;
  /** True when permissionMode === "plan". */
  planMode: boolean;

  // Lazy SettingsManager — reused across updateConfig/readSetting so we
  // don't re-read 6+ JSON files on every /model, /login, etc. The manager
  // handles its own cache invalidation in saveUserSetting().
  private settingsManager: SettingsManager | undefined;

  /**
   * Cached auxiliary-task LLM client, keyed by the models[].key it was built
   * from. Background calls (memory extraction, auto-dream) reuse it across
   * runs so we don't redo the provider handshake every session. Invalidated
   * implicitly: a changed auxModelKey produces a different cache key.
   */
  private auxClientCache?: {
    key: string;
    client: Awaited<ReturnType<typeof createLLMClient>>;
  };

  // Live state from the current/most-recent run, retained for /compact and
  // for live-mutating PermissionClassifier on permission-mode switch.
  private lastContextManager: ContextManager | undefined;
  private lastMessages: Message[] | undefined;
  private lastSessionId: string | undefined;
  private compactedMessagesBySession = new Map<string, Message[]>();
  /**
   * SIDs whose ctx-bar seed we've already emitted in this process. The seed
   * is a rough char/4 estimate; only useful before the first real
   * usage_update arrives (cold start or cross-process resume). On subsequent
   * turns the UI already shows the previous turn's accurate ctx — re-seeding
   * would visibly drop the bar on every submit.
   */
  private ctxSeedSent = new Set<string>();
  /**
   * Per-sid cache of "non-messages overhead" (system prompt + tool defs, in
   * tokens). Survives across turns so each fresh TurnLoop instance can seed
   * its first pre-llm emit with the right offset — without this the ctx bar
   * visibly drops on every user submit (e.g. from ~20k → 3k) until the next
   * LLM response arrives.
   */
  private ctxOverheadBySid = new Map<string, number>();
  /**
   * Step-gap steering queue (per sessionId, in-memory). Host pushes user
   * messages here via enqueueSteer while a run is in flight; the turn loop
   * drains it at each step boundary and splices them into the next LLM request
   * WITHOUT aborting (the 不打断 path, vs cancel+resend). Pure memory, forgotten
   * on process exit — same model as the credential session-allow set, so
   * multiple Engines don't interfere and it stays cleanly extractable.
   */
  private steerQueueBySid = new Map<string, string[]>();
  private activePermission: PermissionClassifier | undefined;
  /**
   * The TurnLoop of the in-flight run(), exposed so extendGoalRun() can bump a
   * running goal's turn/budget ceilings mid-run (TODO 3.1). Null when idle.
   */
  private activeTurnLoop: TurnLoop | null = null;
  /**
   * The goal-stop hook of the in-flight goal run, exposed so clearGoal() can
   * unregister it mid-run (the closure holds the now-cleared goal and would
   * otherwise keep re-blocking the stop). Null when no goal run is active.
   */
  private activeGoalHook: ReturnType<typeof createGoalStopHook> | null = null;

  /** Public accessor so UI/clients can read the resolved per-model window. */
  get maxContextTokens(): number {
    return this.resolveMaxContextTokens();
  }

  private resolveMaxContextTokens(): number {
    const modelEntry = this.modelPool.get();
    return modelEntry?.maxContextTokens ?? this.config.maxContextTokens ?? 200_000;
  }

  /**
   * Compaction thresholds from settings.context, clamped so they keep the
   * required ordering floor < compact < summarize even if the user configures
   * conflicting values (e.g. summarize below compact). Falls back to the
   * ContextManager defaults when a field is absent.
   */
  private resolveContextRatios(): {
    compactAtRatio?: number;
    summarizeAtRatio?: number;
    microcompactFloorRatio?: number;
  } {
    let ctx:
      | {
          compactAtRatio?: number;
          summarizeAtRatio?: number;
          microcompactFloorRatio?: number;
        }
      | undefined;
    try {
      // Read from SettingsManager (shared across all hosts) rather than
      // EngineConfig, mirroring readMemoriesConfig — avoids per-host wiring
      // drift (see memory: personalization host wiring).
      ctx = (
        this.getSettingsManager().get() as {
          context?: {
            compactAtRatio?: number;
            summarizeAtRatio?: number;
            microcompactFloorRatio?: number;
          };
        }
      ).context;
    } catch {
      return {};
    }
    if (!ctx) return {};
    return clampContextRatiosImpl(ctx);
  }

  /**
   * Emit a lifecycle hook with isSubAgent auto-merged into data so handlers
   * can skip noisy injections for spawned children. All Engine-side hook
   * emits should go through this wrapper to keep the context envelope
   * uniform with TurnLoop.emitHook.
   */
  private async emitHook(
    event: HookEventName,
    data: Record<string, unknown> = {},
  ): Promise<HookResult> {
    return this.hooks.emit(event, {
      ...data,
      isSubAgent: this.config.isSubAgent === true,
    });
  }

  /**
   * Read settings.hooks and register a shell-runner wrapper handler per
   * entry. Sub-agents skip shell hooks entirely — spawning child processes
   * per emit for every sub-agent run would multiply token-side overhead
   * for marginal value; explicit users who want sub-agent observability
   * should register SDK-side handlers.
   */
  private registerSettingsHooks(): void {
    if (this.config.isSubAgent === true) return;
    let settings: ReturnType<SettingsManager["get"]>;
    try {
      settings = this.getSettingsManager().get();
    } catch {
      return;
    }
    const entries = settings.hooks ?? [];
    for (const entry of entries) {
      // Soft off-switch (settings hooks UI): the entry stays in the file but
      // doesn't register. reloadHooks() re-runs this, so toggling is hot.
      if (entry.disabled === true) continue;
      const event = entry.event as HookEventName;
      const handler: HookHandler = async (ctx) => {
        if (!shellHookMatches(entry, ctx)) return {};
        return runShellHook(entry, ctx);
      };
      this.hooks.register(
        event,
        handler,
        50,
        `shell:${entry.event}:${entry.command.slice(0, 32)}`,
      );
      // Track the (event, handler) so reloadHooks() can unregister exactly
      // these settings-sourced handlers without touching plugin/goal/code hooks.
      this.settingsHookHandles.push({ event, handler });
    }
  }

  /**
   * Re-apply settings.hooks onto the live HookRegistry after a settings
   * change (config hot-reload layer 2). Surgical: removes ONLY the
   * settings-sourced handlers this Engine previously registered (tracked in
   * settingsHookHandles by identity) and re-runs registerSettingsHooks() from
   * fresh disk settings. Plugin hooks (registered once at construction at
   * priority 80) and goal/builtin/SDK-config hooks are never touched.
   *
   * The SettingsManager cache is invalidated first so the re-read reflects the
   * latest settings.json on disk (mirrors freshSettings()'s load() semantics).
   * Sub-agents never register settings hooks, so this is a no-op for them.
   */
  reloadHooks(): void {
    if (this.config.isSubAgent === true) return;
    // Drop the previously-registered settings handlers by identity.
    for (const { event, handler } of this.settingsHookHandles) {
      this.hooks.unregister(event, handler);
    }
    this.settingsHookHandles = [];
    // Force the next get() to re-read disk so reloaded hooks reflect the
    // newest settings.json, not a stale merged cache.
    try {
      this.getSettingsManager().invalidate();
    } catch {
      // best-effort; registerSettingsHooks below tolerates read failures
    }
    this.registerSettingsHooks();
  }

  constructor(private config: EngineConfig) {
    // Wire shared runtime (adapter pattern — null when self-constructing).
    this.runtime = config.runtime ?? null;

    // Instance-level permission/plan mode fields.
    this.permissionMode = config.permissionMode ?? "acceptEdits";
    this.planMode = this.permissionMode === "plan";

    this.preset = resolveAgentPreset(config.preset);
    // Fold the project's capabilityOverrides.builtin overlay over the global
    // enabled/disabled builtin lists so a project can force-enable a
    // globally-disabled builtin tool or force-disable a globally-enabled one
    // (tri-state). Mirrors readDisabledLists for skills/plugins/agents; no cwd
    // / no overlay → the config lists pass through unchanged (zero regression).
    //
    // #7: this builds the ctor-FROZEN builtin tool SET in the registry — a
    // mid-session project override can't rebuild it. To make a builtin `off`
    // toggle apply mid-session, run()'s per-turn tool-list assembly re-reads
    // readBuiltinOverride(cwd) and HIDES `off` builtins from the turn's tool
    // list (see the allToolDefs filter). `on` here can force-enable a
    // globally-disabled builtin INTO the frozen set at construction; the
    // per-turn path can only hide, not add, so a freshly-`on`'d builtin not in
    // the set needs a session restart to appear.
    const builtinLists = effectiveBuiltinLists(
      config.enabledBuiltinTools ?? [],
      config.disabledBuiltinTools ?? [],
      this.readBuiltinOverride(config.cwd),
    );
    this.toolRegistry = config.runtime?.toolRegistry ?? new ToolRegistry({
      builtinTools: resolveBuiltinToolNames({
        preset: this.preset.name,
        enabledBuiltinTools: builtinLists.enabledBuiltinTools,
        disabledBuiltinTools: builtinLists.disabledBuiltinTools,
      }),
    });
    this.hooks = new HookRegistry();
    // Installed-plugin hooks — declared in each plugin's hooks/hooks.json.
    // Registered first (priority 80) so user-authored hooks at lower
    // priorities (settings: 50, SDK config: default 0) can post-process
    // or stop a plugin's contribution. Sub-agents skip plugin hooks for
    // the same reason they skip settings hooks: per-emit child-process
    // overhead multiplied across sub-agents outweighs the value, and
    // dispatched tasks should run with minimal surface area.
    if (config.isSubAgent !== true) {
      // disabledPlugins suppresses a plugin's hooks too (not just its
      // Skill-tool entries) — see loadPluginHooks. readDisabledLists reads
      // the same settings the prompt composer / tool context use.
      // disabledPluginHooks is the per-hook overlay
      // (capabilityOverrides.pluginHooks); applied at construction, so a
      // toggle takes effect for NEW sessions (same semantics as
      // disabledPlugins itself).
      const { disabledPlugins, disabledPluginHooks } = this.readDisabledLists();
      loadPluginHooks(this.hooks, disabledPlugins, disabledPluginHooks);
    }
    // settings.hooks → shell-command wrappers. Chain order:
    // plugin (80) → shell (50) → code (default 0).
    this.registerSettingsHooks();
    for (const hook of config.hooks ?? []) {
      this.hooks.register(hook.event, hook.handler, hook.priority, hook.name);
    }
    this.sessionManager = new SessionManager(config.sessionStorageDir);

    // Initialize model pool — prefer runtime's shared pool, fall back to self-constructed.
    this.modelPool = config.runtime?.modelPool ?? new ModelPool();
    if (!config.runtime) {
      this.populateModelPoolFromSettings();
    }
  }

  /**
   * Load models[] / providers[] from settings into the active ModelPool and
   * resync this.config.llm with the matching entry. Called from the ctor and
   * from reloadModelPool() (e.g. after onboarding writes new entries to disk).
   */
  private populateModelPoolFromSettings(): void {
    try {
      const sm = this.getSettingsManager();
      sm.invalidate();
      const settings = sm.get();

      // Unified model catalog (统一模型接入方案 §6): register text
      // connections from settings.modelConnections[] into the pool, so the new
      // catalog-driven instance store actually drives model selection. Runs
      // alongside the legacy models[] path below (both coexist); a connection's
      // instance id becomes its pool key. See
      // docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md.
      const connections = (settings as { modelConnections?: unknown[] }).modelConnections;
      if (Array.isArray(connections) && connections.length) {
        const catalog = getMergedCatalog();
        const credentials = (settings as { credentials?: unknown[] }).credentials;
        for (const entry of modelEntriesFromConnections(
          connections as never[],
          (Array.isArray(credentials) ? credentials : []) as never[],
          catalog,
        )) {
          this.modelPool.register(entry);
        }
      }
      const hasConnections = Array.isArray(connections) && connections.length > 0;

      if (settings.models?.length || hasConnections) {
        for (const m of settings.models ?? []) {
          this.modelPool.register({
            key: m.key,
            label: m.label,
            provider: m.provider ?? "",
            model: m.model,
            baseUrl: m.baseUrl,
            apiKey: m.apiKey,
            maxOutputTokens: m.maxOutputTokens,
            maxContextTokens: m.maxContextTokens,
            providerKey: m.providerKey,
            authCommand: (m as { authCommand?: string }).authCommand,
            httpHeaders: (m as { httpHeaders?: Record<string, string> }).httpHeaders,
            serviceTier: (m as { serviceTier?: string }).serviceTier,
            reasoningSummary: (m as { reasoningSummary?: string }).reasoningSummary,
          });
        }
        // Build catalog from settings.providers[] and attach to the pool
        // so model entries can resolve baseUrl/apiKey from their provider.
        if (settings.providers?.length) {
          this.modelPool.setProviderCatalog(
            new ProviderCatalog(settings.providers as never),
          );
        }
        this.modelPool.setCacheDir(defaultCacheDir());
        this.modelPool.reloadCachedContextWindows();
        // Resolve active entry. Priority:
        //   1. settings.activeKey — primary source of truth (new shape).
        //   2. Match settings.model.name against models[].model — legacy
        //      pre-activeKey configs and the migration path.
        // We then switch the pool and write the resolved entry's credentials
        // into config.llm, so the first run() uses the right endpoint instead
        // of whatever env-derived fallback repl.ts seeded earlier.
        // Sub-agents skip the activeKey resync: their llm is chosen by the
        // parent's resolveChildLlm (per-role model routing). activeKey is the
        // *user's* current UI model selection and must not clobber a child's
        // routed model — without this guard a role's `model: flash` is silently
        // overridden back to whatever the user has active in the foreground.
        if (this.config.isSubAgent !== true) {
          // Active-model priority:
          //   1. settings.defaults.text — unified catalog's current text model
          //      (instance id == pool key). Wins so the new store drives.
          //   2. settings.activeKey — legacy primary source of truth.
          //   3. Match settings.model.name against models[].model — oldest path.
          const defaultText = (settings as { defaults?: { text?: string } }).defaults?.text;
          const activeKey = (settings as { activeKey?: string }).activeKey;
          let matchKey: string | undefined;
          if (defaultText && this.modelPool.list().some((e) => e.key === defaultText)) {
            matchKey = defaultText;
          }
          if (!matchKey && activeKey) {
            matchKey = settings.models.find((m: any) => m.key === activeKey)?.key;
          }
          if (!matchKey) {
            const currentModel = this.config.llm.model;
            // OpenRouter stores entries as "provider/model-name"; the top-level
            // settings.model.name is just "model-name". Match either form.
            matchKey = settings.models.find(
              (m: any) =>
                m.model === currentModel ||
                (currentModel && m.model?.endsWith(`/${currentModel}`)),
            )?.key;
          }
          if (matchKey) {
            const entry = this.modelPool.switch(matchKey);
            this.config = {
              ...this.config,
              llm: this.modelPool.toLLMConfig(entry),
            };
          }
        }
      } else if (this.config.llm.apiKey) {
        // Auto-populate pool from the configured API key when models[] is empty.
        // This lets users who only set model.apiKey (without models[]) still
        // use /model to switch between the provider's available models.
        this.autoPopulatePool(this.config.llm.apiKey, this.config.llm.baseUrl);
      }

      // Carry image-attachment settings + sampling temperature into
      // clientDefaults. Both are cross-model knobs — they apply to whatever
      // model is currently active and survive hot-switches. (Pre-cleanup
      // these were merged into llm.imageDetail / llm.temperature; that path
      // is gone because hot-switching now rotates llm wholesale.)
      const imageSettings = (settings as {
        images?: { detail?: "low" | "standard" | "high" | "original" };
      }).images;
      const modelBlock = (settings as { model?: { temperature?: number } }).model;
      const nextDefaults: ClientDefaults = { ...(this.config.clientDefaults ?? {}) };
      let defaultsChanged = false;
      // Migrate legacy "original" → "high" (raw settings may bypass schema).
      const detail = imageSettings?.detail === "original" ? "high" : imageSettings?.detail;
      if (detail && nextDefaults.imageDetail !== detail) {
        nextDefaults.imageDetail = detail;
        defaultsChanged = true;
      }
      if (
        typeof modelBlock?.temperature === "number" &&
        nextDefaults.temperature !== modelBlock.temperature
      ) {
        nextDefaults.temperature = modelBlock.temperature;
        defaultsChanged = true;
      }
      if (defaultsChanged) {
        this.config = { ...this.config, clientDefaults: nextDefaults };
      }
    } catch {
      // Settings not available — pool stays empty
    }
  }

  /**
   * Re-read settings and refresh the model pool. Used after onboarding /login
   * writes new providers[] / models[] to disk so the running engine picks them
   * up without a process restart. Existing pool entries are kept (re-registering
   * the same key overwrites them), so callers don't need to clear first.
   */
  reloadModelPool(): void {
    // When sharing a runtime, the owner of the runtime is responsible
    // for populating the pool; reloading from settings here would
    // blast that owner's contributions and affect every other Engine
    // that shares this runtime.
    if (!this.runtime) {
      this.populateModelPoolFromSettings();
    }
  }

  /**
   * Auto-populate the model pool when settings.models[] is empty but
   * the user has configured an API key. Detects the provider from the
   * key prefix / baseUrl and registers all its known models.
   */
  private autoPopulatePool(apiKey: string, baseUrl?: string): void {
    const provider = detectProviderFromApiKey(apiKey, baseUrl);
    if (!provider) return;
    const entries = buildModelPool(provider, apiKey);
    for (const e of entries) {
      this.modelPool.register(e);
    }
    // Activate the first registered model as the zero-config default.
    // Users override via the onboarding wizard or `/model`.
    const defaultEntry = entries[0];
    if (defaultEntry) {
      const entry = this.modelPool.switch(defaultEntry.key);
      this.config = {
        ...this.config,
        llm: this.modelPool.toLLMConfig(entry),
      };
    }
  }

  /**
   * Register a custom tool (from product adapter) into the tool registry.
   * Must be called before run().
   */
  registerCustomTool(
    definition: import("../types.js").RegisteredTool,
    executor: BuiltinToolFn,
  ): void {
    this.toolRegistry.registerTool(definition, executor);
  }

  /**
   * Inject the askUser handler after construction. Used by AgentServer
   * to wire its protocol-backed askUser into an Engine that was created
   * before the server existed (chicken-and-egg: server takes engine in ctor).
   */
  setAskUser(fn: AskUserFn | undefined): void {
    this.config.askUser = fn;
  }

  /**
   * Inject the browser automation bridge after construction (same chicken-and-egg
   * as setAskUser: the desktop host builds the bridge — which drives a webview —
   * after the Engine exists). Undefined → the browser_* tools degrade with a
   * clear "no browser panel" error.
   */
  setBrowserBridge(bridge: import("../tool-system/browser-bridge.js").BrowserBridge | undefined): void {
    this.config.browserBridge = bridge;
  }

  /**
   * Queue a user message to be spliced into the in-flight run for `sessionId`
   * at the next turn-loop step boundary — the 不打断 steering path (vs cancel +
   * resend). General-purpose: any host path (UI 引导, future agent coordination,
   * external triggers) can call it. If no run is active for the session the
   * message simply waits in the queue and is consumed when that session next
   * runs (rare race; host normally only steers while busy). No-op on blank text.
   */
  enqueueSteer(sessionId: string, text: string): void {
    const t = text?.trim();
    if (!sessionId || !t) return;
    const q = this.steerQueueBySid.get(sessionId) ?? [];
    q.push(t);
    this.steerQueueBySid.set(sessionId, q);
  }

  /** Drain + clear the steer queue for a session (turn loop consumes per step). */
  private consumeSteer(sessionId: string): string[] {
    const q = this.steerQueueBySid.get(sessionId);
    if (!q || q.length === 0) return [];
    this.steerQueueBySid.set(sessionId, []);
    return q;
  }

  /** Wire the cookie→browser injection callback (InjectCredential tool). Same
   *  post-construction injection model as setBrowserBridge. */
  setInjectCredential(
    fn: import("../tool-system/context.js").InjectCredentialFn | undefined,
  ): void {
    this.config.injectCredentialToBrowser = fn;
  }

  /**
   * Whether this engine runs unattended (no interactive human). Used by the
   * in-process AgentServer to decide whether to wire an interactive askUser.
   */
  isHeadless(): boolean {
    return this.config.headless === true;
  }

  /**
   * Run a task from start to finish.
   */
  async run(
    task: string,
    options?: {
      cwd?: string;
      onStream?: StreamCallback;
      signal?: AbortSignal;
      sessionId?: string;
      /**
       * Goal mode for this run: the engine registers a GoalStopHook so the
       * turn loop runs until the session model judges this goal met. Falls
       * back to config.goal. Orthogonal to permissionMode. Accepts a raw
       * string or a full GoalConfig; normalized once at the run boundary.
       */
      goal?: string | GoalConfig;
    },
  ): Promise<EngineResult> {
    // When the caller omits cwd but is resuming an existing session, recover
    // that session's bound cwd from disk so a project-bound session keeps
    // loading its own agents/settings/memory even if the host's UI repo
    // selection has drifted to null. Only probe on omission — an explicit cwd
    // always wins, and a fresh session has nothing to recover.
    const sessionCwd =
      options?.cwd === undefined && options?.sessionId
        ? this.sessionManager.readCwd(options.sessionId)
        : undefined;
    const cwd = resolveRunCwd({
      optionCwd: options?.cwd,
      sessionCwd,
      configCwd: this.config.cwd,
      processCwd: process.cwd(),
    });

    // Wrap the caller's onStream so we can intercept `task_update`
    // events emitted by TodoWrite and keep an in-engine snapshot.
    // TaskGuard reads this snapshot at turn end to decide whether to
    // nag about stale in_progress items. Without the wrapper we'd
    // have no way to observe TodoWrite's emission — the canonical
    // store is the transcript, but TaskGuard runs in-loop and can't
    // afford a transcript scan per turn.
    let latestTodos: TaskInfo[] = [];
    const userOnStream = options?.onStream;
    const wrappedOnStream: StreamCallback = (event) => {
      if (event.type === "task_update") {
        latestTodos = event.tasks;
      }
      // Persist goal progress so replay/history shows how many rounds the
      // goal ran. Display-only — toMessages() ignores this type, so it never
      // re-enters the LLM context.
      if (event.type === "goal_progress") {
        session.transcript.append("goal_progress", {
          status: event.status,
          round: event.round,
          ...(event.gaps ? { gaps: event.gaps } : {}),
        });
      }
      userOnStream?.(event);
    };
    if (options) options.onStream = wrappedOnStream;

    // ── P2-6: image input ─────────────────────────────────────────────
    // Parse `<codeshell-image>` blocks out of the raw task string before
    // any other gate looks at it. Two concerns:
    //   1. The noise detector below sees the raw base64 as gibberish and
    //      would reject the whole turn — split images out first so it
    //      only inspects the prose portion.
    //   2. Models that don't accept vision must be refused immediately,
    //      with the image bytes intact for the user to retry on another
    //      model. Silent text-only fallback was the failure mode this
    //      gate is here to prevent.
    let parsedTask: ParsedTask;
    try {
      parsedTask = parseTaskWithImages(task);
    } catch (err) {
      const msg = (err as Error).message;
      logger.warn("engine.run.image_parse_failed", { error: msg });
      return {
        text: `ERROR: image attachment is malformed (${msg}). Drop the image and try again, or re-attach it.`,
        reason: "image_error",
        sessionId: options?.sessionId ?? "image-parse-failed",
        turnCount: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    }
    if (parsedTask.hasImages) {
      const cap = capabilitiesFor(
        (this.config.llm.providerKind ?? this.config.llm.provider) as ProviderKindName,
        this.config.llm.model,
      );
      if (!cap.supportsVision) {
        logger.warn("engine.run.vision_not_supported", {
          provider: this.config.llm.provider,
          model: this.config.llm.model,
          imageCount: parsedTask.images.length,
        });
        return {
          text:
            `ERROR: model "${this.config.llm.model}" does not accept image input. ` +
            `Switch to a vision-capable model (e.g. gpt-4o, claude-sonnet, gemini-1.5-pro) and resend.`,
          reason: "image_error",
          sessionId: options?.sessionId ?? "vision-not-supported",
          turnCount: 0,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      }
      // Size gate. Hosts (desktop renderer, TUI) are expected to
      // pre-compress to IMAGE_TARGETS — if they didn't, we fail the turn
      // fast with a clear message instead of letting the OpenAI client
      // grind through three 16-second "Connection error" retries on a
      // 4 MB body. See `image-policy.ts` for the rationale and limits.
      let verdict = enforceImagePolicy(parsedTask.images);
      if (!verdict.ok && verdict.code === "image_too_large") {
        // One image blew the per-image cap. Try the engine-side
        // compressor (jimp-backed when installed; no-op otherwise) so
        // TUI / MCP paths that lack a host-side resize don't fail
        // outright on a screenshot they could have rescaled. The
        // re-check below is what decides whether we proceed.
        const compressed = await tryCompressImages(parsedTask.images);
        if (compressed.anyCompressed) {
          parsedTask.images = compressed.images;
          logger.info("engine.run.image_compressed", {
            before: verdict.offender?.bytes,
            after: compressed.images.reduce(
              (s, i) => s + byteLengthFromBase64(i.base64),
              0,
            ),
          });
          verdict = enforceImagePolicy(parsedTask.images);
        }
      }
      // After compression, anything still over the per-image cap is
      // dropped with a textual placeholder instead of failing the
      // turn (TODO-week.md #9e). The "5MB brick session" failure
      // mode from Claude Code (research doc §A) was the case where a
      // poisoned image entered history and every subsequent request
      // re-sent it; placeholders keep history clean while letting
      // the rest of the turn run.
      if (!verdict.ok && verdict.code === "image_too_large") {
        const drop = dropOversizedImages(parsedTask.images);
        if (drop.droppedCount > 0) {
          parsedTask.images = drop.kept;
          parsedTask.hasImages = drop.kept.length > 0;
          parsedTask.text = drop.placeholder + "\n\n" + parsedTask.text;
          logger.warn("engine.run.image_dropped", {
            droppedCount: drop.droppedCount,
            keptCount: drop.kept.length,
          });
          verdict = enforceImagePolicy(parsedTask.images);
        }
      }
      if (!verdict.ok) {
        // Cumulative / count caps can't be rescued by per-image
        // dropping (well — too_many_images could trim by FIFO, but
        // that's a bigger UX call than we want to make silently).
        // Refuse the turn with the policy message.
        logger.warn("engine.run.image_policy_failed", {
          code: verdict.code,
          imageCount: verdict.totals.imageCount,
          totalBytes: verdict.totals.totalBytes,
          offender: verdict.offender,
        });
        return {
          text: `ERROR: ${verdict.message}`,
          reason: "image_error",
          sessionId: options?.sessionId ?? `image-policy-${verdict.code}`,
          turnCount: 0,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      }
    }
    // For downstream noise-detection + transcript persistence we want the
    // *text* portion only — base64 bytes count as "noise" by the heuristic
    // and would also bloat the transcript by megabytes per image. Image
    // bytes ride in parsedTask.images and re-enter the message tree below.
    const taskText = parsedTask.hasImages ? parsedTask.text : task;

    const noise = detectPastedNoise(taskText);
    if (noise.isNoise) {
      const hint =
        `Your input looks like pasted terminal output (${noise.reason}). ` +
        `I didn't start a task. What would you like to ask?` +
        (noise.cleaned ? `\n\nExtracted text: ${noise.cleaned.slice(0, 200)}` : "");
      logger.info("engine.run.rejected", { reason: noise.reason, len: task.length });
      return {
        text: hint,
        reason: "completed",
        sessionId: options?.sessionId ?? "noise-rejected",
        turnCount: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    }

    // Build the per-Engine ToolContext that will be threaded through every
    // tool call. Replaces the old module-level singletons (setAskUserFn,
    // setArenaLLMConfig, setSubAgentConfig, setToolSearchRegistry).
    const subAgentSpawner: SubAgentSpawner = {
      parentStream: options?.onStream,
      describe: () => ({
        cwd,
        preset: this.preset.name,
        permissionMode: this.config.permissionMode ?? "acceptEdits",
      }),
      spawn: async (req) => {
        // No nested agents. Strip Agent / AgentStatus / AgentCancel from the
        // child's tool pool so the LLM can't spawn grandchildren — matches
        // Claude Code's ALL_AGENT_DISALLOWED_TOOLS approach. Without this
        // guard a runaway model could fork-bomb sub-agents (token cost +
        // background process explosion), and the sid / approval / dock
        // model assumes a flat parent→children hierarchy. Layered with a
        // runtime check in agent.ts as defense-in-depth.
        const { enabled: childEnabled, disabled: childDisabled } = resolveChildToolScope(
          req.toolAllowlist,
          this.config.disabledBuiltinTools,
          this.config.enabledBuiltinTools,
        );
        const childLlm = resolveChildLlm(req.model, this.modelPool, this.config.llm);
        const child = new Engine({
          llm: childLlm,
          // Inherit parent's runtime knobs (temperature, image detail, timeouts)
          // but cap sub-agent retries at 2 — they're short-lived and we'd
          // rather surface failures than burn a 9 s exponential backoff loop.
          clientDefaults: { ...(this.config.clientDefaults ?? {}), retryMaxAttempts: 2 },
          cwd,
          permissionMode: this.config.permissionMode,
          preset: this.preset.name,
          enabledBuiltinTools: childEnabled,
          disabledBuiltinTools: childDisabled,
          customSystemPrompt: this.config.customSystemPrompt,
          appendSystemPrompt:
            [this.config.appendSystemPrompt, req.appendSystemPrompt]
              .filter(Boolean)
              .join("\n\n") || undefined,
          responseLanguage: this.config.responseLanguage,
          userProfile: this.config.userProfile,
          instructions: this.config.instructions,
          maxTurns: req.maxTurns,
          maxContextTokens: this.config.maxContextTokens ?? 200_000,
          sessionStorageDir: this.config.sessionStorageDir,
          headless: this.config.headless,
          readOnlySession: req.readOnlySession,
          skillAllowlist: req.skillAllowlist,
          sandbox: this.config.sandbox,
          // Subagents inherit the parent's scope: a child runs in the same
          // cwd/session, so it should see the same config layers the parent did.
          settingsScope: this.config.settingsScope ?? "project",
          isSubAgent: true,
        });
        // Where the spawned child Engine's stream events go. AgentTool's
        // background path passes a `streamOverride` (transcriptSink) so the
        // per-event detail is captured into the agent's transcript instead
        // of flooding the main feed. Sync calls leave streamOverride unset
        // and we fall back to the parent UI's onStream so synchronous
        // sub-agents still render inline.
        const destStream: StreamCallback | undefined =
          req.streamOverride ?? options?.onStream;
        const childStream: StreamCallback | undefined = destStream
          ? (event) => {
              // Filter ctx-bar signals: the bar tracks the main conversation's
              // prompt size, and a sub-agent's own session emits would clobber
              // it (its sid is new, its messages are tiny, the rough char/4
              // seed lands the bar at <1% mid-turn). Sub-agent token accounting
              // lives in CostTracker (recordUsage), not the ctx bar.
              //
              // - session_started: would seed main ctx with sub-agent's prompt
              // - usage_update: would overwrite main ctx with sub-agent's prompt
              // - context_compact: would reset main ctx to sub-agent's post-compact
              //   value AND print a misleading "context compacted" boundary in
              //   the main chat (the main session didn't compact).
              if (
                event.type === "usage_update" ||
                event.type === "session_started" ||
                event.type === "context_compact"
              ) {
                return;
              }
              destStream({ ...event, agentId: req.agentId } as typeof event);
            }
          : undefined;
        // child.run() establishes its own runWithSid scope internally, so
        // child log lines route to the child's sid and parent's ALS
        // binding is unaffected when control returns here.
        const result = await child.run(req.prompt, { signal: req.signal, onStream: childStream });
        return result.text;
      },
    };

    // Priority: config.sandbox → project settings.sandbox → global → per-run
    // default. Read UNMERGED per-scope (getForScope) so a project that wrote no
    // sandbox genuinely follows global, rather than inheriting global's mode and
    // looking like it set one. Fixes "项目级配了不生效" + the scope model.
    let projectSandbox: SettingsSandbox | undefined;
    let globalSandbox: SettingsSandbox | undefined;
    try {
      const sm = this.getSettingsManager();
      if (this.config.isSubAgent !== true) {
        projectSandbox = (sm.getForScope("project", cwd) as { sandbox?: SettingsSandbox }).sandbox;
      }
      globalSandbox = (sm.getForScope("user") as { sandbox?: SettingsSandbox }).sandbox;
    } catch {
      // settings unavailable → fall through to per-run default
    }
    const sandboxConfig = resolveSandboxConfig(
      this.config.sandbox,
      projectSandbox,
      globalSandbox,
      this.config.headless === true,
    );
    // A2: explicit sandbox modes (seatbelt, bwrap) must fail closed
    // per standard §S4. resolveSandboxBackend throws when an explicit
    // mode is unavailable on this host; we let it propagate. The
    // previous behavior — catching the throw inside the hot turn and
    // silently downgrading to "off" — was the leak A2 closes. The
    // `auto` mode handles its own downgrade with a one-time warning
    // inside resolveSandboxBackend; explicit modes do not.
    //
    // Backend is cached per runtime/engine so the capability probe runs once
    // per (mode, cwd) instead of every turn.
    const sandboxBackend = this.runtime
      ? await this.runtime.resolveSandbox(sandboxConfig, cwd)
      : await this.resolveSandboxWithoutRuntime(sandboxConfig, cwd);

    // Observability: surface what sandbox actually applied this run — the
    // configured mode vs the resolved backend (auto may downgrade to off when
    // no OS backend is available) + the network policy. Without this you can't
    // tell whether shell commands were isolated /网络放没放. One line per run.
    logger.info("sandbox.resolved", {
      mode: sandboxConfig.mode,
      backend: sandboxBackend.name,
      isolated: sandboxBackend.name !== "off",
      network: sandboxConfig.network,
      cwd,
    });

    // sessionId is filled in after the session bundle is resolved below
    // (the session may be cold-started or resumed). Until then this is
    // intentionally shaped as a mutable local; we treat it as immutable
    // after the assignment.
    const toolCtx: ToolContext = {
      ...this.buildToolContext(),
      subAgentSpawner,
      agentDefinitions: this.getAgentDefinitions(cwd),
      // Stamp the resolved network policy onto the backend the tools see so
      // Bash can surface "网络 deny" on its result. Shallow-copy (don't mutate
      // the cached backend) — `wrap`/`hintForBlockedOutput` are plain function
      // properties and survive the spread. Off keeps network undefined.
      sandbox:
        sandboxBackend.name === "off"
          ? sandboxBackend
          : { ...sandboxBackend, network: sandboxConfig.network },
      cwd,
      // TodoWrite reads this to push task_update events independently
      // of its return value, so the UI's pinned task panel refreshes
      // immediately rather than after the LLM next surfaces the
      // snapshot. wrappedOnStream snoops the same channel to keep
      // latestTodos current for TaskGuard.
      streamCallback: options?.onStream,
    };

    logger.info("engine.run", {
      task: taskText.slice(0, 200),
      cwd,
      model: this.config.llm.model,
      preset: this.preset.name,
      imageCount: parsedTask.images.length,
    });

    // Compose the user-turn payload once so resume + cold paths agree on
    // shape. With images, content becomes a ContentBlock[] holding one
    // text block (when prose is present) followed by one image block per
    // attachment — the provider-specific clients translate this to OpenAI
    // `image_url` or Anthropic `{type:image, source:base64}` downstream.
    // When an attached image came from a workspace FILE (the desktop composer's
    // path-attach flow sets ParsedImage.name = the absolute path), surface that
    // path to the model as text. The image bytes still ride along for vision,
    // but tools that operate on files — GenerateImage(referenceImages),
    // Read, etc. — need the on-disk path, not just the pixels. Without this the
    // path the composer already knew was silently dropped, and the model would
    // answer "图片没落到项目文件夹，找不到路径" (the seedance 图生图 dead-end).
    // Only names that resolve to an existing file qualify; a pasted screenshot
    // whose name is just "screenshot.png" is not a path and is left out.
    const attachedPaths = collectAttachedImagePaths(
      parsedTask.images,
      (name) => (isAbsolute(name) ? name : join(cwd, name)),
      existsSync,
    );
    const pathHint =
      attachedPaths.length > 0
        ? `\n\n<attached-image-paths>\n${attachedPaths.join("\n")}\n</attached-image-paths>\n` +
          `(上面附带的图片在工作区的真实路径，如需把它们作为工具输入（例如 GenerateImage 的 referenceImages、图生图参考图），直接使用这些路径。)`
        : "";

    const userMessageContent: string | ContentBlock[] = parsedTask.hasImages
      ? [
          ...(parsedTask.text || pathHint
            ? [{ type: "text" as const, text: `${parsedTask.text}${pathHint}` }]
            : []),
          ...parsedTask.images.map((img) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: img.mime,
              data: img.base64,
            },
          })),
        ]
      : taskText;

    // Create or resume session.
    //
    // Three valid shapes:
    //   1. options.sessionId names an EXISTING on-disk session → resume
    //   2. options.sessionId names a fresh sid the host wants materialized
    //      (ChatSessionManager's "tui-main" first-turn case) → create
    //      with that explicit sid so subsequent turns can resume cleanly
    //   3. no sessionId → create with nanoid
    //
    // Shape (2) was previously broken — engine threw SessionError,
    // surfacing as `[-32603] Session not found: <sid>` on the very first
    // TUI turn. Detection now uses `sessionManager.exists()` (one stat
    // call) instead of a try/catch on resume.
    let session: SessionBundle;
    let messages: Message[];

    if (options?.sessionId && this.sessionManager.exists(options.sessionId)) {
      session = this.sessionManager.resume(options.sessionId);
      const cachedCompacted = this.compactedMessagesBySession.get(options.sessionId);
      messages = cachedCompacted ? [...cachedCompacted] : session.transcript.toMessages();
      // If the previous run was Ctrl+C'd or crashed between an assistant
      // tool_use and the matching tool_result being persisted, the
      // loaded sequence is invalid for OpenAI (which 400s on dangling
      // tool_calls). Patch synthetic tool_results so the next API call
      // doesn't fail before the turn even starts.
      const patched = patchOrphanedToolUses(messages);
      if (patched.gapsPatched > 0) {
        logger.warn("engine.resume.patched_orphaned_tool_uses", {
          sessionId: options.sessionId,
          gaps: patched.gapsPatched,
          toolResults: patched.toolResultsInjected,
        });
      }
      // Restore cost state from previous session, if the caller injected a store
      if (session.state.costState && this.config.costStore) {
        this.config.costStore.restore(session.state.costState);
      }
      // Append new user message
      const userMsg: Message = { role: "user", content: userMessageContent };
      messages.push(userMsg);
      session.transcript.appendMessage("user", userMessageContent);
      // Flush "active" status to disk immediately. resume() set it in memory
      // (session-manager.ts), but without this write the on-disk state.json
      // still shows the previous run's terminal reason — so any external
      // observer (another CLI process, /sid, the session list) would think
      // the session is still errored/aborted while we're actually running.
      this.sessionManager.saveState(session.state);
    } else {
      // Cold start: shape (2) reuses the host-supplied sid; shape (3)
      // lets sessionManager generate one with nanoid.
      session = this.sessionManager.create(
        cwd,
        this.config.llm.model,
        this.config.llm.provider,
        options?.sessionId,
        this.config.isSubAgent === true ? getCurrentSid() : undefined,
        this.config.isSubAgent === true ? "subagent" : this.config.origin,
      );
      messages = [{ role: "user", content: userMessageContent }];
      session.transcript.appendMessage("user", userMessageContent);
      // Save first user message as session summary — text only. The summary
      // shows up in the session list; "[image]" is more informative than a
      // truncated `[object Object]` when the prompt was purely visual.
      const summarySrc = parsedTask.hasImages
        ? parsedTask.text || `[image${parsedTask.images.length > 1 ? `s × ${parsedTask.images.length}` : ""}]`
        : taskText;
      session.state.summary = summarySrc.slice(0, 80).replace(/\n/g, " ");
      this.sessionManager.saveState(session.state);
    }

    // Bump the conversation-turn counter: this user message starts a new turn.
    // One user message = one turn, regardless of how many turn-loop iterations
    // or tool calls it spans. File-history snapshots taken below are tagged
    // with this value so `/undo` reverts exactly this turn's file changes.
    // (Both resume and cold-start paths converge here.)
    session.state.turnSeq = (session.state.turnSeq ?? 0) + 1;

    // Stamp the resolved session id for downstream logging.
    //
    // `setCurrentSid` updates the module-level fallback so any code path
    // running outside an ALS scope (bootstrap, /sid before a run starts)
    // still sees the latest sid.
    //
    // The real isolation comes from wrapping the rest of `run` in
    // `runWithSid(sid, async () => { ... })`: every `getCurrentSid()`
    // call inside that closure — including those inside `await`ed child
    // Engine.run() calls — reads sid from this scope's
    // AsyncLocalStorage binding, not the module global. Sibling Engines
    // running concurrently each get their own scope; an `enterSid` inside
    // a child mutates that child's scope only and doesn't leak back to
    // the parent's chain after `await child.run(...)` returns.
    setCurrentSid(session.state.sessionId);

    // B2 / Gate 1: stamp the resolved sid onto the tool context so
    // session-scoped side effects (background-agent completion
    // notifications) attribute to the right session. toolCtx is created
    // before the session bundle is resolved (see ~line 635), so this is
    // the first point we can set it. After this assignment treat the
    // field as immutable for the rest of the run.
    toolCtx.sessionId = session.state.sessionId;
    return runWithSid(session.state.sessionId, async () => {

    recordSessionStart(session.state.sessionId, {
      // Strip <codeshell-image> base64 payloads before they reach
      // <repo>/log/. Reader still sees the marker + byte count, just
      // not the bytes. Transcript persistence keeps the full payload.
      task: sanitizeTaskString(task),
      cwd,
      model: this.config.llm.model,
      provider: this.config.llm.provider,
      permissionMode: this.config.permissionMode ?? "acceptEdits",
      resumed: !!options?.sessionId,
    });

    // Session-level hook: fired once per Engine.run() entry, regardless of
    // cold-start vs resume. Handlers can return `messages` to inject a
    // <system-reminder> at the head of the conversation (between
    // userContext and the new user prompt). Used by the built-in
    // superpowers injector to surface the `using-superpowers` ruleset.
    const sessionStartHook = await this.emitHook("on_session_start", {
      sessionId: session.state.sessionId,
      cwd,
      resumed: !!options?.sessionId,
    });

    // Per-turn hook: fired every time a new user prompt enters the loop.
    // Equivalent to CC's UserPromptSubmit. Handlers can inject lightweight
    // reminders that should accompany each user turn (e.g. "skills
    // available — check before acting").
    const promptSubmitHook = await this.emitHook("user_prompt_submit", {
      sessionId: session.state.sessionId,
      // Pass the text-only portion. Handlers reading the prompt for keyword
      // detection / classification (e.g. superpowers' "did the user ask
      // about X?") don't gain anything from megabytes of base64 inlined here,
      // and silently leaking attachment bytes through hooks is the kind of
      // exfiltration risk a curious user-installed shell hook shouldn't carry.
      prompt: taskText,
      resumed: !!options?.sessionId,
    });
    // updatedPrompt: handler rewrote the user's prompt text. Replace the
    // last user message we just pushed (cold-start: line ~511; resume:
    // line ~500). Original prompt is in the transcript already — we log
    // the rewrite so audit chains know a hook touched user input.
    if (typeof promptSubmitHook.updatedPrompt === "string") {
      const lastIdx = messages.length - 1;
      const last = messages[lastIdx];
      if (last && last.role === "user" && typeof last.content === "string") {
        logger.info("hook.updated_prompt", {
          sessionId: session.state.sessionId,
          originalChars: last.content.length,
          updatedChars: promptSubmitHook.updatedPrompt.length,
        });
        messages[lastIdx] = { role: "user", content: promptSubmitHook.updatedPrompt };
      }
    }

    // Rough token estimate of the full prompt so the UI's ctx bar isn't 0%
    // before the first real usage_update arrives. The authoritative count
    // comes from `usage.promptTokens` after the first LLM response — this is
    // just a display-friendly approximation for the first frame.
    //
    // Only seed once per (process, sid). On subsequent turns the UI already
    // shows the previous turn's accurate ctx; overwriting it with this rough
    // char/4 estimate would make the bar visibly drop on every submit.
    const sid = session.state.sessionId;
    const needsCtxSeed = !this.ctxSeedSent.has(sid);
    const roughPromptTokens = needsCtxSeed
      ? messages.reduce((sum, m) => {
          const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
          return sum + Math.ceil(text.length / 4);
        }, 0)
      : 0;
    if (needsCtxSeed) this.ctxSeedSent.add(sid);

    // Tell the client the sid *now* instead of waiting for run() to resolve.
    // The user wants `/sid` to work mid-turn; without this, the client only
    // learns the sid when the run completes.
    options?.onStream?.({
      type: "session_started",
      sessionId: sid,
      promptTokens: roughPromptTokens,
    });

    // Replay the last TodoWrite snapshot on resume so the UI's pinned
    // task panel re-hydrates without the LLM needing to call TodoWrite
    // again. Scans the resumed transcript newest-first (and tolerates
    // legacy TaskCreate/Update events for sessions recorded against
    // the pre-2026-05-24 API). New sessions have no transcript yet so
    // readLastTodoSnapshot returns null and nothing is emitted.
    if (options?.sessionId) {
      const snap = readLastTodoSnapshot(session.transcript.getEvents());
      if (snap && snap.length > 0) {
        latestTodos = snap;
        options?.onStream?.({ type: "task_update", tasks: snap });
      }
    }

    // Kick off LLM client creation early (network handshake)
    const llmClientPromise = createLLMClient(this.config.llm, this.config.clientDefaults);

    const mode = this.config.permissionMode ?? "acceptEdits";
    const { rules: defaultRules, backend: approvalBackend } = this.buildPermissionConfig(mode, cwd);

    const permission = new PermissionClassifier(defaultRules, mode, approvalBackend);
    this.activePermission = permission;

    // If the backend is the interactive one, wire it for project-scope
    // persistence: it needs cwd to find settings.local.json, and a callback
    // to apply newly-saved rules to the live classifier so subsequent calls
    // in this same session don't re-prompt. Headless/auto backends skip
    // this — they don't prompt, so there are no project rules to persist.
    if (approvalBackend instanceof InteractiveApprovalBackend) {
      approvalBackend.setCwd(cwd);
      approvalBackend.setOnProjectRules((rules) => {
        // Prepend the *full* accumulated list of session-saved project rules
        // so user approvals win over defaults and earlier approvals aren't
        // dropped when later ones come in.
        permission.reconfigure(mode, approvalBackend, [...rules, ...defaultRules]);
      });
    }

    const toolExecutor = new ToolExecutor(this.toolRegistry, permission, this.hooks);
    const investigationGuard = new InvestigationGuard();
    if (this.config.readOnlySession) {
      investigationGuard.setPolicy("read-only-review");
    } else if (this.config.headless) {
      investigationGuard.setSoftMode(true);
    }
    toolExecutor.setInvestigationGuard(investigationGuard);
    toolExecutor.setTaskGuard(new TaskGuard(() => latestTodos));

    // Wire abort signal for cascading cancellation + per-Engine ToolContext
    toolExecutor.setSignal(options?.signal);
    toolExecutor.setContext(toolCtx);

    const contextManager = new ContextManager({
      maxTokens: this.resolveMaxContextTokens(),
      // Drop undefined fields so they don't clobber ContextManager defaults
      // (spread of `{x: undefined}` would override the default with undefined).
      ...Object.fromEntries(
        Object.entries(this.resolveContextRatios()).filter(([, v]) => v !== undefined),
      ),
    });
    this.lastContextManager = contextManager;

    const { disabledSkills, disabledPlugins } = this.readDisabledLists();
    const promptComposer = new PromptComposer({
      cwd,
      model: this.config.llm.model,
      preset: this.preset,
      customSystemPrompt: this.config.customSystemPrompt,
      appendSystemPrompt: this.config.appendSystemPrompt,
      responseLanguage: this.config.responseLanguage,
      userProfile: this.config.userProfile,
      instructionOptions: { compatFileNames: compatFileNamesFrom(this.config.instructions) },
      disabledSkills,
      disabledPlugins,
      skillAllowlist: this.config.skillAllowlist,
      memoriesMaxAgeDays: this.readMemoriesConfig()?.maxAge,
    });

    // Connect MCP servers (if configured and not already connected).
    // B1: prefer the Runtime-owned MCPManager so all sessions in a
    // worker share one set of connections. Falling back to a
    // per-Engine instance keeps the null-runtime path (tests, ad-hoc
    // scripts) working.
    const mcpServers = this.config.mcpServers ?? {};
    if (Object.keys(mcpServers).length > 0 && !this.mcpManager) {
      if (this.runtime) {
        this.mcpManager = this.runtime.mcpPool;
      } else {
        this.mcpManager = new MCPManager(this.toolRegistry);
      }
      await this.mcpManager.connectAll(mcpServers, this);
    }

    // Parallelize slow initialization:
    //   1. createLLMClient — network handshake (started earlier)
    //   2. buildSystemPrompt — includes git status (3 execSync calls)
    //   3. buildSystemContext — reads environment context
    // Inject the live available-agent-types listing into the Agent tool's
    // description. The registry is per-engine (loaded from .code-shell/agents
    // for this cwd), so it can't live in the static tool def — without this
    // the model never learns the reusable roles exist and spawns nameless
    // ad-hoc agents instead (the Core A/B/C incident).
    // The Agent tool is always available: with configured roles, an omitted
    // agent_type falls back to one of them (see resolveAgentTypeOverrides); with
    // no roles configured it runs a true ephemeral agent, so workflows that need
    // sub-agents (e.g. superpowers) work in any project.
    // Availability guard (tool-visibility): a gated builtin (WebSearch needs a
    // search provider, GenerateImage needs an OpenAI provider) is hidden from
    // the toolDefs the model sees when its credential isn't configured for this
    // cwd. Recomputed every message, so configuring a key takes effect on the
    // NEXT message without a restart. Tools with no guard entry are always kept.
    const guardCwd = toolCtx.cwd;
    // #7: per-turn project builtin override. The toolRegistry's builtin tool
    // SET is ctor-frozen (and may be shared via runtime), so a mid-session
    // project override of a builtin can't rebuild the registry. But the tool
    // LIST handed to the LLM is assembled fresh every turn, so we apply the
    // override here: a builtin marked `off` for this cwd is HIDDEN from the
    // turn's tool list (matching how skills/plugins/agents `off` apply
    // mid-session via readDisabledLists). `on`/`inherit` keep whatever the
    // registry already has — we can't re-add a tool the frozen registry omits,
    // but `on` for a tool already present is a no-op (it stays). This makes a
    // builtin toggle take effect on the NEXT message, like other capability
    // kinds, without touching the registry.
    const builtinOverride = this.readBuiltinOverride(guardCwd);
    // Turn `off` from a prompt-visibility filter into a real execution gate:
    // collect the builtin tool names the override marks `off` and hand them to
    // the executor (via the shared toolCtx the executor already holds a
    // reference to, set at setContext above) so it rejects a call to a hidden
    // builtin instead of running it from the still-populated registry.
    if (builtinOverride) {
      const registryNames = new Set(
        this.toolRegistry.getToolDefinitions().map((t) => t.name),
      );
      const disabledBuiltins = new Set(
        Object.keys(builtinOverride).filter(
          (name) => builtinOverride[name] === "off" && registryNames.has(name),
        ),
      );
      toolCtx.disabledBuiltins = disabledBuiltins;
    }
    // MCP tool exposure is per-SESSION even though the pool/registry are
    // worker-shared (B1): a server connected by another project's session
    // registers its tools into the SHARED registry, and without this filter
    // they leaked into every session (e.g. chrome-devtools tools showing up
    // in a project that never enabled the plugin). Keep an MCP tool only when
    // its server is in THIS session's merged config.mcpServers — which
    // already folds the project's capabilityOverrides. Gated on the config
    // being present: engines without one (sub-agents, bare tests) have no
    // MCP tools in their private registries anyway.
    const allowedMcpServers = new Set(
      Object.entries(this.config.mcpServers ?? {})
        .filter(([, c]) => c.enabled !== false)
        .map(([n]) => n),
    );
    toolCtx.allowedMcpServers = allowedMcpServers;
    const mcpVisible = (toolName: string): boolean => {
      const reg = this.toolRegistry.getTool(toolName) as
        | { source?: string; serverName?: string }
        | null;
      return reg?.source !== "mcp" || allowedMcpServers.has(reg?.serverName ?? "");
    };
    // Feature-flag visibility: a builtin mapped in TOOL_FEATURE_FLAGS is
    // hidden when its flag resolves to false (default-on flags only hide when
    // explicitly disabled, so zero regression out of the box). Read once per
    // turn so flipping a flag in settings takes effect on the NEXT message,
    // like the other capability kinds.
    const featureFlags = this.readFeatureFlags();
    const allToolDefs = applyBuiltinOverrideVisibility(
      this.toolRegistry.getToolDefinitions(),
      builtinOverride,
    )
      .filter((t) => mcpVisible(t.name))
      .filter((t) => {
        const guard = BUILTIN_TOOL_GUARDS.get(t.name);
        return guard ? guard(guardCwd) : true;
      })
      .filter((t) => {
        const flag = TOOL_FEATURE_FLAGS.get(t.name);
        return flag ? isFeatureEnabled(featureFlags, flag) : true;
      })
      // Dynamic per-engine bits the static defs can't carry: the Agent tool's
      // agent_type enum + listing, and the image/video provider names. See
      // applyDynamicToolDef — forwarding only the Agent description (dropping
      // its rebuilt inputSchema) used to strip the agent_type enum, so the
      // model omitted agent_type and configured roles never applied.
      .map((t) => applyDynamicToolDef(t, toolCtx.agentDefinitions, guardCwd));

    // In plan mode, only expose read-only/planning tools so the model won't
    // attempt writes. Shared with executor.ts's execution gate via
    // PLAN_MODE_ALLOWED_TOOLS so what the model SEES and what the executor
    // RUNS can't drift apart. (Bash is in the set; the executor additionally
    // gates Bash to read-only commands at call time.)
    const toolDefs = this.planMode
      ? allToolDefs.filter((t) => PLAN_MODE_ALLOWED_TOOLS.has(t.name))
      : allToolDefs;

    const [llmClient, systemPrompt, systemContext] = await Promise.all([
      llmClientPromise,
      promptComposer.buildSystemPrompt(toolDefs),
      promptComposer.buildSystemContext(),
    ]);
    const fullSystemPrompt = [systemPrompt, systemContext].filter(Boolean).join("\n\n");

    // Prepend userContext (CLAUDE.md) as first message (sync, fast)
    const userContextMsg = promptComposer.buildUserContextMessage();
    if (userContextMsg) {
      messages.unshift(userContextMsg);
    }

    // Inject hook-supplied reminders just before the most recent user task.
    // Combined into one <system-reminder> block so a noisy handler chain
    // doesn't turn into 3+ separate user turns in the API request.
    const lifecycleReminder = wrapHookMessages([
      ...(sessionStartHook.messages ?? []),
      ...(promptSubmitHook.messages ?? []),
    ]);
    if (lifecycleReminder) {
      // messages[length - 1] is the user task we just pushed above. Insert
      // the reminder immediately before it so the model reads: CLAUDE.md →
      // reminder → user request.
      messages.splice(messages.length - 1, 0, lifecycleReminder);
    }
    this.lastSessionId = session.state.sessionId;
    this.lastMessages = messages;

    // Wire up LLM summarization for context compaction
    // Uses a lightweight call without tools
    contextManager.setTranscriptPath(session.transcript.getFilePath());
    // Re-derive frozen persistence decisions from the messages we just
    // loaded. Skipped on cold start (messages == [userContextMsg] only).
    // Critical for resume — otherwise a result that was persisted last
    // run would be evaluated fresh and might get a different replacement
    // string than the one already in the message, breaking idempotency.
    contextManager.initReplacementStateFromMessages(messages);
    // Summarization (context-compaction + tool-result summaries) are auxiliary
    // calls — route them to the configured aux model so they don't burn the
    // expensive primary model every turn (same rationale as runMemoryPipeline).
    // Resolved once here (not per-call) so the magnetic-disk settings re-read
    // in resolveAuxClient stays off the compaction hot path. Falls back to the
    // primary client when no aux model is configured.
    const auxSummaryClient = await this.resolveAuxClient(llmClient);
    contextManager.setSummarizeFn(async (prompt: string) => {
      const summaryResponse = await auxSummaryClient.createMessage({
        systemPrompt: "You are a conversation summarizer. Be concise and factual.",
        messages: [{ role: "user", content: prompt }],
        tools: [],
        maxTokens: 1024,
        // Auxiliary call — no need to burn reasoning tokens. On DeepSeek V4
        // this flips thinking off (~3x faster, fewer tokens); on every other
        // OpenAI-compatible provider the field is ignored.
        reasoning: { mode: "off" },
      });
      return summaryResponse.text;
    });

    // Create components (requires resolved llmClient). Build fallback clients
    // (TODO 7.2) from settings.fallbackModelKeys so a terminal failure on the
    // primary model retries against a backup before surfacing to the user.
    const fallbackClients = await this.resolveFallbackClients();
    const modelFacade = new ModelFacade(llmClient, session.transcript, fallbackClients);

    // Wire getOutputTokens for token budget tracking
    modelFacade.getOutputTokens = () => {
      const usage = llmClient.getUsage();
      return usage.totalCompletionTokens;
    };

    // Wire summarize for tool use summaries (uses lightweight call).
    // recordUsage=false keeps these auxiliary sub-calls out of the main usage
    // tracker so session_end.cost reflects only the user-facing turns and
    // turns/requestCount stay aligned.
    modelFacade.summarize = async (sysPrompt: string, userMsg: string) => {
      const resp = await auxSummaryClient.createMessage({
        systemPrompt: sysPrompt,
        messages: [{ role: "user", content: userMsg }],
        tools: [],
        maxTokens: 256,
        recordUsage: false,
        // Auxiliary call — see contextManager.setSummarizeFn above.
        reasoning: { mode: "off" },
      });
      logger.debug("summarize.call", {
        sysPromptLen: sysPrompt.length,
        userMsgLen: userMsg.length,
        userMsgPreview: userMsg.slice(0, 300),
        completionLen: resp.text.length,
        completionPreview: resp.text.slice(0, 300),
        stopReason: resp.stopReason,
        promptTokens: resp.usage?.promptTokens,
        completionTokens: resp.usage?.completionTokens,
      });
      return resp.text;
    };

    // File history: auto-backup before Write/Edit
    const sessionDir = join(
      this.config.sessionStorageDir ?? join(userHome(), ".code-shell", "sessions"),
      session.state.sessionId,
    );
    const fileHistory = FileHistory.loadFromDir(sessionDir);

    // Keep a reference so we can unregister in the finally below. Registering an
    // anonymous handler every run() leaks: unregister matches by handler
    // identity, so without a stored reference each run stacks another identical
    // on_tool_start handler that fires (and re-snapshots) on every tool forever.
    const fileHistoryHandler: HookHandler = async (context) => {
      const toolName = context.data?.toolName as string;
      const args = context.data?.args as Record<string, unknown> | undefined;
      // Tag snapshots with the current turn (stamped above before any tool
      // runs) so turn-level /undo can revert just this user message's edits.
      const turnSeq = session.state.turnSeq;
      if ((toolName === "Write" || toolName === "Edit") && args?.file_path) {
        const path = args.file_path as string;
        // saveSnapshot returns null when the file does not exist yet — this
        // hook runs BEFORE the tool, so a null here means the turn is CREATING
        // the file. Record it (idempotent per turn) so /undo can delete it and
        // /redo can recreate it.
        if (fileHistory.saveSnapshot(path, turnSeq) === null && turnSeq !== undefined) {
          fileHistory.recordCreated(path, turnSeq);
        }
      } else if (toolName === "ApplyPatch" && typeof args?.patch === "string") {
        // ApplyPatch mutates files too, so /undo must see them. Snapshot every
        // existing file the patch updates or deletes (adds have no prior
        // content). Resolve relative patch paths against the engine cwd, the
        // same base ApplyPatch itself uses.
        const cwd = this.config.cwd ?? process.cwd();
        for (const target of patchBackupTargets(args.patch, cwd)) {
          fileHistory.saveSnapshot(target, turnSeq);
        }
      }
      return {};
    };
    this.hooks.register("on_tool_start", fileHistoryHandler, 100, "file_history_backup");

    // Hook: agent start
    await this.emitHook("on_agent_start", {
      sessionId: session.state.sessionId,
      task,
      model: this.config.llm.model,
    });

    // Goal mode: register a GoalStopHook for the lifetime of THIS run so the
    // turn loop keeps going until the session model judges the goal met.
    // Registered per-run (and cleared in `finally`) so a later goal-less
    // send doesn't inherit a stale goal. The judge runs on `auxSummaryClient`
    // — the same cheap aux model used for summarize/compaction — not the
    // (potentially expensive) session model: "is this goal met?" is a classic
    // aux-tier task, and a goal run can invoke the judge up to maxStopBlocks
    // times.
    // Normalize the raw goal (string | GoalConfig) once at the run boundary;
    // everything inward uses the GoalConfig. normalizeGoal() returns undefined
    // when there's effectively no goal (empty objective).
    //
    // PERSISTENT GOAL (CC /goal style): a goal set on one send survives across
    // later sends and manual interrupts until met or cleared. Resolution:
    //   1. options.goal — this send explicitly sets/replaces the goal.
    //   2. session.state.activeGoal — a goal set on an earlier send.
    //   3. config.goal — engine-level default (rare; e.g. headless).
    // When (1) supplies a goal that differs from the stored one we REPLACE the
    // persisted active goal (one active goal per session) and announce it. A
    // bare send with no options.goal inherits the stored active goal so the
    // model keeps working toward it — that's what makes it persistent.
    const explicitGoal = normalizeGoal(options?.goal);
    const storedGoal = this.config.isSubAgent !== true ? session.state.activeGoal : undefined;
    if (explicitGoal && this.config.isSubAgent !== true) {
      const replaced = !!storedGoal && storedGoal.objective !== explicitGoal.objective;
      session.state.activeGoal = explicitGoal;
      this.sessionManager.saveState(session.state);
      options?.onStream?.({
        type: "goal_set",
        objective: explicitGoal.objective,
        replaced,
      });
    }
    const normalizedGoal = explicitGoal ?? storedGoal ?? normalizeGoal(this.config.goal);
    let goalHookHandler: ReturnType<typeof createGoalStopHook> | null = null;
    if (normalizedGoal && this.config.isSubAgent !== true) {
      goalHookHandler = createGoalStopHook({
        goal: normalizedGoal,
        llm: auxSummaryClient,
        log: logger,
        // Clear the persisted active goal the moment the judge says it's met,
        // so a later bare send doesn't re-inherit a satisfied goal. The hook
        // calls this from inside its met branch (single source of truth for
        // "goal achieved"); engine owns the persistence side-effect.
        onMet: () => {
          if (session.state.activeGoal) {
            session.state.activeGoal = undefined;
            this.sessionManager.saveState(session.state);
          }
        },
      });
      this.hooks.register("on_stop", goalHookHandler, 0, "goal-stop");
      // Expose for clearGoal() mid-run. Already guarded by isSubAgent above.
      this.activeGoalHook = goalHookHandler;
    }

    // Surface compaction events to the UI so the user knows when context was trimmed.
    // Buffer the most recent event so TurnLoop can drain it and emit the
    // post_compact hook on the next turn (ContextManager itself doesn't
    // know about HookRegistry — the buffer is the seam).
    let pendingCompactInfo: { strategy: string; before: number; after: number } | null = null;
    contextManager.setOnCompact((info) => {
      pendingCompactInfo = info;
      options?.onStream?.({ type: "context_compact", ...info });
    });

    // Run turn loop
    const turnLoop = new TurnLoop(
      {
        model: modelFacade,
        toolExecutor,
        contextManager,
        hooks: this.hooks,
        transcript: session.transcript,
        systemPrompt: fullSystemPrompt,
        tools: toolDefs,
        sessionId: sid,
        isSubAgent: this.config.isSubAgent === true,
        consumePendingCompactInfo: () => {
          const info = pendingCompactInfo;
          pendingCompactInfo = null;
          return info;
        },
        consumeSteer: () => this.consumeSteer(sid),
        ctxOverheadStore: {
          get: (s) => this.ctxOverheadBySid.get(s) ?? 0,
          set: (s, n) => {
            this.ctxOverheadBySid.set(s, n);
          },
        },
      },
      {
        // Goal mode raises the turn ceiling: an unattended goal run keeps
        // getting re-blocked by the stop-hook until it's done, and the 100
        // interactive default would silently truncate a long objective. The
        // real backstops are the goal token/time budgets + maxStopBlocks.
        maxTurns: resolveMaxTurns(this.config.maxTurns, normalizedGoal),
        // Consecutive stop-block cap: config override > goal.maxStopBlocks >
        // GOAL_DEFAULT_MAX_STOP_BLOCKS(25). The old hardcoded 8 was too tight
        // for complex goals that legitimately get re-blocked while advancing.
        maxStopBlocks: resolveMaxStopBlocks(this.config.maxStopBlocks, normalizedGoal),
        // 25 (was 10): modern models routinely batch >10 parallel tool calls
        // (e.g. reading a dozen files at once). At 10 the excess was silently
        // dropped; the turn loop now also warns the model when it caps, but a
        // higher ceiling avoids the round-trip in the common case. (B-3)
        maxToolCallsPerTurn: this.config.maxToolCallsPerTurn ?? 25,
        onStream: options?.onStream,
        signal: options?.signal,
        // Goal mode: the active goal is surfaced to the on_stop handler via
        // ctx.data.goal; the GoalStopHook (registered above) judges it.
        goal: normalizedGoal,
        // Heartbeat: flush turnCount + tokens to state.json after every turn
        // so external observers (other CLI processes, /sid, the session list)
        // see live progress instead of a stale snapshot from the last
        // completed run.
        onTurnBoundary: (turnCount) => {
          session.state.turnCount = turnCount;
          const u = modelFacade.getUsage();
          session.state.tokenUsage = {
            promptTokens: u.totalPromptTokens,
            completionTokens: u.totalCompletionTokens,
            totalTokens: u.totalTokens,
          };
          if (this.config.costStore) {
            session.state.costState = this.config.costStore.serialize() as Record<
              string,
              unknown
            >;
          }
          this.sessionManager.saveState(session.state);
        },
      },
    );

    // Expose this run's loop for mid-run extension (TODO 3.1). Top-level only —
    // a sub-agent's loop is its own concern and isn't user-extendable.
    if (this.config.isSubAgent !== true) this.activeTurnLoop = turnLoop;

    let result: Awaited<ReturnType<typeof turnLoop.run>>;
    try {
      result = await turnLoop.run(messages);

      // ── Headless: drain background sub-agents before resolving ───────
      // Unified background-work model (2026-06-17): the engine NO LONGER parks
      // every run waiting on background work. Background work (sub-agents,
      // video polls, shells) ends the turn, yields, and is picked up later by
      // the server's notification-wakeup path (maybeWakeIdleSession). The
      // INTERACTIVE path relies on that wakeup + a run-boundary re-check.
      //
      // HEADLESS is the exception: a one-shot `engine.run` whose caller takes
      // `result.text` as THE answer (automation / SDK) has no later turn to
      // pick up a wakeup — so it must wait, before resolving, until its own
      // background SUB-AGENTS finish and summarize. Only sub-agents (their
      // summary IS part of this run's result), NOT shells (a dev server never
      // exits → would hang headless forever) and NOT video (a long render the
      // one-shot run shouldn't block on). This replaces the old for(;;) park
      // (s-mpvf4rsj-bb6e4639 invariant) for the headless case only.
      const sid = session.state.sessionId;
      const isTopLevel = this.config.isSubAgent !== true;
      if (isTopLevel && this.isHeadless()) {
        let aborted = options?.signal?.aborted === true;
        // Loop: a summarize turn can spawn a NEW background sub-agent; keep
        // draining + summarizing until none remain. turnCount accumulates, so
        // the turn-loop's maxTurns still bounds runaway re-summarization.
        for (;;) {
          while (!aborted && asyncAgentRegistry.hasRunningForSession(sid)) {
            aborted = await this.waitForBackgroundAgentChange(sid, options?.signal);
          }
          let pending = notificationQueue.drainAll(sid);
          if (aborted && pending.length === 0) {
            // Abort race: an agent calls markCompleted (registry notify) and only
            // THEN enqueue (queue notify) as two separate statements. If the abort
            // fired before that agent's completion `.then` ran, the while above
            // exited on `aborted`, this drainAll caught nothing, and a naive
            // `break` here would drop the agent's output. Give still-settling
            // agents a bounded window to finish enqueuing, then drain once more.
            // Each wait is timeout-bounded so a genuinely stuck (never-completing)
            // agent can't hang abort cleanup forever — we'd rather lose nothing in
            // the common case and not hang in the pathological one.
            for (let i = 0; i < 20 && asyncAgentRegistry.hasRunningForSession(sid); i++) {
              const changed = await this.waitForBackgroundAgentChangeOrTimeout(sid, 25);
              if (!changed) break; // timed out with no state change → stop waiting
            }
            pending = notificationQueue.drainAll(sid);
            if (pending.length === 0) break;
          } else if (pending.length === 0) {
            break;
          }
          const injected: Message = {
            role: "user",
            content: `<system-reminder>\n${buildNotificationMessage(pending)}\n</system-reminder>`,
          };
          if (aborted) {
            session.transcript.appendMessage(injected.role, injected.content);
            result = { ...result, messages: [...result.messages, injected] };
            break;
          }
          result = await turnLoop.run([...result.messages, injected]);
        }
      }
    } finally {
      // Run-scoped: drop the GoalStopHook so a later goal-less send on this
      // long-lived engine doesn't keep blocking stops.
      if (goalHookHandler) this.hooks.unregister("on_stop", goalHookHandler);
      if (this.activeGoalHook === goalHookHandler) this.activeGoalHook = null;
      if (this.activeTurnLoop === turnLoop) this.activeTurnLoop = null;
      // Run-scoped too: this handler is re-registered every run(), so it must be
      // dropped here or it stacks duplicates that re-snapshot on every tool.
      this.hooks.unregister("on_tool_start", fileHistoryHandler);
    }
    this.lastMessages = result.messages;
    this.compactedMessagesBySession.set(
      session.state.sessionId,
      this.stripUserContextMessage(result.messages, userContextMsg),
    );

    logger.info("engine.done", {
      sessionId: session.state.sessionId,
      reason: result.reason,
      turns: turnLoop.currentTurn,
      tokens: modelFacade.getUsage().totalTokens,
    });
    recordSessionEnd(session.state.sessionId, {
      reason: result.reason,
      turns: turnLoop.currentTurn,
      cost: modelFacade.getUsage(),
    });

    // Session-level hook: fired symmetrically with on_session_start once
    // the turn loop has resolved (completion, error, or abort). Handlers
    // are notify-only — any returned messages are dropped because the run
    // is already over and there's no next turn to inject into.
    await this.emitHook("on_session_end", {
      sessionId: session.state.sessionId,
      reason: result.reason,
      turnCount: turnLoop.currentTurn,
    });

    // Fire-and-forget memory pipeline: extract durable memories from the
    // transcript, save a session summary, and conditionally trigger
    // auto-dream consolidation. Doesn't block the Engine result.
    void this.runMemoryPipeline(session.transcript, session.state.sessionId, cwd, llmClient);

    // Fire-and-forget session title generation — only after the FIRST turn.
    // Reuses the already-resolved auxSummaryClient (aux model, cheap). Best-
    // effort: failures never touch the run result. The renderer writes the
    // title into the sidebar on receipt of the session_title stream event.
    {
      const messageEvents = session.transcript.getEvents("message");
      const userMsgEvents = messageEvents.filter(
        (e) => (e.data as { role?: string }).role === "user",
      );
      const userMsgCount = userMsgEvents.length;
      const onStream = options?.onStream;
      if (userMsgCount === 1 && onStream && result.text) {
        const rawContent = (userMsgEvents[0]?.data as { content?: unknown })?.content;
        const firstUserText =
          typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent ?? "");
        void buildSessionTitle(auxSummaryClient, firstUserText, result.text)
          .then((title) => {
            if (title) {
              // Persist the title so it survives a localStorage wipe / disk
              // rebuild — it used to live only in the renderer's localStorage
              // index. This .then resolves AFTER the saveState below (:1892), so
              // it must save again itself rather than rely on that write.
              session.state.title = title;
              this.sessionManager.saveState(session.state);
              onStream({
                type: "session_title",
                sessionId: session.state.sessionId,
                title,
              });
            }
          })
          .catch(() => {});
      }
    }

    // Update session state. Persist the raw terminal reason as the status so
    // callers can distinguish user-cancelled (aborted_streaming) from real
    // failures (model_error, prompt_too_long, ...) — previously every
    // non-completed outcome collapsed to "errored", which threw away the
    // distinction and misled anyone reading state.json.
    session.state.turnCount = turnLoop.currentTurn;
    session.state.status = result.reason;
    const usage = modelFacade.getUsage();
    session.state.tokenUsage = {
      promptTokens: usage.totalPromptTokens,
      completionTokens: usage.totalCompletionTokens,
      totalTokens: usage.totalTokens,
    };
    if (this.config.costStore) {
      session.state.costState = this.config.costStore.serialize() as Record<string, unknown>;
    }
    this.sessionManager.saveState(session.state);

    // Hook: agent end
    await this.emitHook("on_agent_end", {
      sessionId: session.state.sessionId,
      reason: result.reason,
      turnCount: turnLoop.currentTurn,
    });

    // Emit completion
    options?.onStream?.({ type: "turn_complete", reason: result.reason });

    return {
      text: result.text,
      reason: result.reason,
      sessionId: session.state.sessionId,
      turnCount: turnLoop.currentTurn,
      usage: {
        promptTokens: usage.totalPromptTokens,
        completionTokens: usage.totalCompletionTokens,
        totalTokens: usage.totalTokens,
      },
    };
    });
  }

  /**
   * Run the end-of-session memory pipeline as a fire-and-forget background
   * task. Extracts durable memories from the transcript, saves a session
   * summary, and conditionally triggers auto-dream consolidation.
   */
  /**
   * Resolve the LLM client for background/auxiliary work (memory extraction,
   * auto-dream). When settings.auxModelKey names a valid pool model, build (and
   * cache) a dedicated client for it so per-turn book-keeping runs on a cheap
   * fast model instead of the expensive primary. Falls back to `fallback` (the
   * active run's client) when unset, unknown, or on any build failure — aux
   * work is best-effort and must never break a run.
   */
  private async resolveAuxClient(
    fallback: Awaited<ReturnType<typeof createLLMClient>>,
  ): Promise<Awaited<ReturnType<typeof createLLMClient>>> {
    let auxKey: string | undefined;
    try {
      // Re-read from disk: settings may have been changed by the desktop
      // (a separate process) since this worker last cached them. This runs
      // once per run on the post-run background path, so the cost is fine.
      const sm = this.getSettingsManager();
      sm.invalidate();
      // Unified store's defaults.auxText (a connection id = pool key) wins over
      // the legacy auxModelKey. Both resolve to a pool key below.
      auxKey = resolveAuxKey(sm.get() as { defaults?: { auxText?: string }; auxModelKey?: string });
    } catch {
      return fallback;
    }
    if (!auxKey) return fallback;

    // Don't spin up a second client when the aux key resolves to the SAME
    // client config as this engine's active model. Compare FULL LLM IDENTITY
    // (model + reasoning + maxTokens + baseUrl + provider/providerKind) against
    // this engine's own per-session config.llm — NOT a separately-tracked active
    // key, and NOT just the model NAME. Two distinct pool keys can share the same
    // `model` string yet differ in reasoning/maxOutputTokens/baseUrl/apiKey/
    // providerKey; de-duping on the name alone would wrongly route the user's
    // chosen aux entry onto the primary's config. config.llm is isolated per
    // session and always set for a real run, so this is correct even for desktop
    // worker sessions built with a shared runtime (which never explicitly
    // switchModel, so the old activeModelKey field was undefined and defeated the
    // de-dup), AND immune to another session mutating the shared pool's activeKey.
    const entry = this.modelPool.get(auxKey);
    if (entry && sameLlmIdentity(this.modelPool.toLLMConfig(entry), this.config.llm)) {
      return fallback;
    }

    if (this.auxClientCache?.key === auxKey) return this.auxClientCache.client;

    if (!entry) {
      logger.warn("engine.aux_model_missing", { auxModelKey: auxKey });
      return fallback;
    }
    try {
      const client = await createLLMClient(
        this.modelPool.toLLMConfig(entry),
        this.config.clientDefaults,
      );
      this.auxClientCache = { key: auxKey, client };
      return client;
    } catch (err) {
      logger.warn("engine.aux_model_build_failed", {
        auxModelKey: auxKey,
        error: (err as Error).message,
      });
      return fallback;
    }
  }

  /**
   * Build the ordered list of fallback LLM clients from
   * settings.fallbackModelKeys (TODO 7.2). Each key that resolves to a pool
   * model (and isn't identical to the active model) becomes a client tried, in
   * order, when the primary fails terminally. Build failures and unknown keys
   * are skipped with a warning — fallback is best-effort and must never break a
   * run's construction.
   */
  private async resolveFallbackClients(): Promise<
    Array<Awaited<ReturnType<typeof createLLMClient>>>
  > {
    let keys: string[] = [];
    try {
      const sm = this.getSettingsManager();
      keys = (sm.get() as { fallbackModelKeys?: string[] }).fallbackModelKeys ?? [];
    } catch {
      return [];
    }
    if (!keys.length) return [];
    const clients: Array<Awaited<ReturnType<typeof createLLMClient>>> = [];
    for (const key of keys) {
      const entry = this.modelPool.get(key);
      if (!entry) {
        logger.warn("engine.fallback_model_missing", { key });
        continue;
      }
      const llm = this.modelPool.toLLMConfig(entry);
      // Skip a fallback identical to the active model — it'd just fail again.
      if (sameLlmIdentity(llm, this.config.llm)) continue;
      try {
        clients.push(await createLLMClient(llm, this.config.clientDefaults));
      } catch (err) {
        logger.warn("engine.fallback_model_build_failed", {
          key,
          error: (err as Error).message,
        });
      }
    }
    return clients;
  }

  private async runMemoryPipeline(
    transcript: import("../session/transcript.js").Transcript,
    sessionId: string,
    cwd: string,
    primaryClient: Awaited<ReturnType<typeof createLLMClient>>,
  ): Promise<void> {
    try {
      // Background calls run on the auxiliary model when configured, so memory
      // book-keeping doesn't burn the expensive primary model every turn.
      // settings.memories.extractionModel (if set + valid) overrides the aux
      // model specifically for memory extraction (TODO 8.1).
      const llmClient = await this.resolveExtractionClient(primaryClient);
      // Only run memory extraction for substantive sessions. The previous
      // threshold of 4 user+assistant messages was low enough that two-line
      // exchanges ("what's the time?" / "noon") triggered a full LLM
      // extraction, which then padded the memory store with low-signal
      // entries. 8 messages is roughly "more than a single back-and-forth"
      // — substantive enough to be worth a durable note.
      const messages = transcript.toMessages().filter(
        (m) => m.role === "user" || m.role === "assistant",
      );
      if (messages.length < 8) return;

      // Memory orchestrator + dream-loop calls are auxiliary LLM calls
      // that don't (and shouldn't) carry image payloads. Sanitize before
      // stringify so we don't pump a 10 MB base64 string into the
      // summarization prompt — provider 400s on it, and it leaks bytes
      // into a downstream cost-tracking path we don't audit as carefully
      // as the primary turn.
      const plainMessages = messages.map((m) => {
        const safe = sanitizeContent(m.content);
        return {
          role: m.role,
          content: typeof safe === "string" ? safe : JSON.stringify(safe),
        };
      });

      const orchestrator = new MemoryOrchestrator({
        callLLM: async (sysPrompt, userMsg) => {
          // Use a lightweight auxiliary call (no tools, no streaming, no
          // reasoning tokens).
          const resp = await llmClient.createMessage({
            systemPrompt: sysPrompt,
            messages: [{ role: "user", content: userMsg }],
            tools: [],
            maxTokens: 1024,
            recordUsage: false,
            reasoning: { mode: "off" },
          });
          return resp.text;
        },
        runDream: async ({ systemPrompt, userPrompt, projectDir }) =>
          this.runDreamLoop({ systemPrompt, userPrompt, projectDir, llmClient, sessionId }),
        projectDir: cwd,
        // settings.memories.maxCount caps memories accepted per extraction;
        // autoExtract=false turns the extractor off (summaries/dream stay).
        maxCount: this.readMemoriesConfig()?.maxCount,
        autoExtract: this.readMemoriesConfig()?.autoExtract,
      });

      await orchestrator.run(plainMessages, sessionId);
    } catch (err) {
      // Memory pipeline is best-effort — never surface errors to the user.
      logger.warn("engine.memory_pipeline_failed", {
        sessionId,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Drive the auto-dream tool-call loop.
   *
   * Runs the LLM with a whitelisted subset of memory tools (MemoryList,
   * MemoryRead, MemorySave, MemoryDelete). The loop is intentionally small
   * and offline:
   *   - No streaming, no UI events — runs in the background after a session.
   *   - No permission prompts — UI isn't attached, so we hard-reject any
   *     attempt to Save/Delete in the "user" scope before dispatching. Dream
   *     scope is the LLM's workspace and goes through freely.
   *   - Capped at MAX_TURNS LLM round-trips and MAX_WRITES total
   *     mutations to bound damage on misbehavior.
   *
   * Returns true if the loop ran (with or without writes); false if we
   * bailed before the first LLM call (e.g. registry missing the tools).
   */
  private async runDreamLoop(opts: {
    systemPrompt: string;
    userPrompt: string;
    projectDir?: string;
    llmClient: Awaited<ReturnType<typeof createLLMClient>>;
    sessionId: string;
  }): Promise<boolean> {
    // The loop body now lives in services/dream-consolidation.ts so it can
    // also be driven from the desktop host's manual "整理 / Dream" trigger.
    // The orchestrator built systemPrompt/userPrompt from this engine's
    // MemoryManager already; runDreamConsolidation rebuilds them from the same
    // projectDir, so passing them here would be redundant — we just hand it the
    // tool registry + a memory-scoped tool context.
    const { ran } = await runDreamConsolidation({
      llmClient: opts.llmClient,
      toolRegistry: this.toolRegistry,
      toolContext: this.buildToolContext(),
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
    });
    return ran;
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  /**
   * Switch the active model by pool key. Takes effect on the next run() call.
   * Returns the new model entry.
   *
   * Persists settings.activeKey (and a legacy settings.model.* mirror) so the
   * next process startup defaults to the same model — without this, switches
   * only live in memory and every restart reverts to the previously persisted
   * activeKey.
   */
  switchModel(key: string): ModelEntry {
    const entry = this.modelPool.switch(key);
    // LLMConfig is pure model identity now — rotate it wholesale. Cross-model
    // runtime knobs (temperature/timeout/retryMaxAttempts/imageDetail) live on
    // this.config.clientDefaults and survive the switch untouched.
    const nextLlm = this.modelPool.toLLMConfig(entry);
    this.config = { ...this.config, llm: nextLlm };
    this.persistActiveModel(entry, nextLlm);
    return entry;
  }

  /**
   * Write the active model selection to ~/.code-shell/settings.json.
   *
   * We mirror into the legacy settings.model.* block (provider/name/apiKey/
   * baseUrl) because boot paths in cli/main.ts, repl.ts, run.ts still read it.
   * The mirror uses resolved llm values (not raw entry.*) so credentials that
   * live on settings.providers[] flow through correctly — entry.apiKey is
   * undefined when the entry resolves via providerCatalog.
   */
  private persistActiveModel(entry: ModelEntry, llm: LLMConfig): void {
    try {
      // userHome() (not raw homedir()) so a test that sets process.env.HOME to
      // a tmpdir gets its writes isolated too — the SettingsManager reader
      // already honors HOME; the writer must match or tests pollute the real
      // ~/.code-shell/settings.json (this happened: an A-key/model-a leak).
      const dir = join(userHome(), ".code-shell");
      const file = join(dir, "settings.json");
      mkdirSync(dir, { recursive: true });

      let existing: Record<string, unknown> = {};
      if (existsSync(file)) {
        try {
          existing = JSON.parse(readFileSync(file, "utf-8"));
        } catch {
          // corrupt file — bail rather than clobber the user's config
          return;
        }
      }

      const prevModel =
        typeof existing.model === "object" && existing.model
          ? (existing.model as Record<string, unknown>)
          : {};
      const updated: Record<string, unknown> = {
        ...existing,
        activeKey: entry.key,
        model: {
          ...prevModel,
          provider: llm.provider,
          name: entry.model,
          apiKey: llm.apiKey,
          baseUrl: llm.baseUrl,
        },
      };

      const tmp = `${file}.${process.pid}.tmp`;
      const payload = JSON.stringify(updated, null, 2) + "\n";
      writeFileSync(tmp, payload, "utf-8");
      try {
        renameSync(tmp, file);
      } catch {
        writeFileSync(file, payload, "utf-8");
      }
    } catch (err) {
      logger.warn(
        `persistActiveModel failed: ${(err as Error).message}`,
      );
    }
  }

  /** Get the model pool. */
  getModelPool(): ModelPool {
    return this.modelPool;
  }

  /** Get the current model name (full path). */
  getCurrentModel(): string {
    return this.config.llm.model;
  }

  getHookRegistry(): HookRegistry {
    return this.hooks;
  }

  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  getConfig(): EngineConfig {
    return this.config;
  }

  /**
   * Config hot-reload "layer 2": merge a disk-default config patch into this
   * ALREADY-RUNNING session's `this.config`, reload settings hooks, and
   * incrementally connect any newly-added MCP servers. Applied at the next
   * turn boundary — an in-flight turn is NOT interrupted: it keeps using the
   * PromptComposer it was built with, and the next turn rebuilds the composer
   * from the freshly-merged config (composer is rebuilt per-turn).
   *
   * `version` is a monotonic counter from the server: stale (<=last applied)
   * payloads are dropped so out-of-order reload deliveries can't let an older
   * config clobber a newer one (Q5).
   *
   * MCP: reconciles the shared MCP pool against the new disk-default server
   * set. Added servers connect idempotently; removed/disabled servers are
   * disconnected and their registered MCP tools are unregistered so plugin
   * disable takes effect without an Electron restart.
   *
   * Preset (#2): a preset hot-reload re-resolves `this.preset` so the next-turn
   * PromptComposer picks up the new preset's system prompt / behavior — that's
   * the main user-visible preset effect and it IS hot. The toolRegistry's
   * builtin tool SET, however, is ctor-frozen (and may be shared via runtime):
   * it is NOT rebuilt here. So a preset change that alters the builtin tool set
   * (e.g. general → terminal-coding adds LSP/Brief) only takes effect on the
   * next session restart; we log a warning when that case is detected.
   *
   * disk-default-vs-slice caveat (#8): the patch carries pure DISK-default
   * values (preset/customSystemPrompt/appendSystemPrompt/responseLanguage/
   * userProfile — see diskDefaultsFrom). Spreading them here OVERRIDES any
   * per-request slice override of the same field. This is correct for the
   * desktop host today (its per-request slice only carries permissionMode+cwd,
   * which are excluded from the disk patch). A future host that sets
   * slice.preset (or the other prompt fields) per-request MUST exclude those
   * from the reload patch — or track per-request overrides separately — or this
   * reload will clobber them back to disk values.
   */
  refreshRuntimeConfig(patch: Partial<EngineConfig>, version: number): void {
    if (version <= this.lastAppliedConfigVersion) return;
    const prevServers = this.config.mcpServers ?? {};
    const prevPresetName = this.preset.name;
    this.config = { ...this.config, ...patch };
    // #2: re-resolve the prompt-affecting preset so the next-turn PromptComposer
    // (rebuilt per turn from this.preset) reflects the new preset's system
    // prompt / behavior. Only when the preset actually changed.
    if (patch.preset !== undefined && patch.preset !== prevPresetName) {
      const nextPreset = resolveAgentPreset(this.config.preset);
      // The builtin tool SET is ctor-frozen and may be shared via runtime — we
      // do NOT rebuild it here. If the new preset implies a different builtin
      // tool set, that part of the change only lands on session restart.
      const prevTools = resolveBuiltinToolNames({ preset: prevPresetName }).slice().sort().join(",");
      const nextTools = resolveBuiltinToolNames({ preset: nextPreset.name }).slice().sort().join(",");
      if (prevTools !== nextTools) {
        logger.warn("engine.preset_reload.tool_set_change_needs_restart", {
          from: prevPresetName,
          to: nextPreset.name,
          note: "preset system prompt hot-reloaded; builtin tool-set change takes effect on session restart",
        });
      }
      this.preset = nextPreset;
    }
    this.reloadHooks();
    if (patch.mcpServers && this.mcpManager) {
      // Fire-and-forget reconcile (connect added / disconnect removed servers).
      // It must NOT surface as an unhandled rejection: a single flaky server
      // that fails to connect/disconnect during hot-reload would otherwise
      // crash the host process (or be silently swallowed). Catch + log so the
      // reconcile is best-effort and the next reload can retry.
      void this.mcpManager.reconcile(patch.mcpServers, this).catch((err) => {
        logger.error("engine.mcp_reconcile_failed", {
          error: err instanceof Error ? err.message : String(err),
          version,
        });
      });
    }
    this.lastAppliedConfigVersion = version;
  }

  /**
   * Inject context into a session's transcript without triggering a LLM turn.
   * The injected content appears as an assistant message so the LLM can see it
   * in subsequent conversations. The transcript auto-flushes to disk.
   *
   * Also updates the in-memory compacted message cache so the next
   * engine.run() call for this session picks up the injected content
   * instead of a stale snapshot from the previous run.
   */
  /**
   * Clear a session's persisted active goal (CC `/goal clear`). Works whether
   * the session is idle or its goal run is in flight: it wipes
   * `state.activeGoal` (so the next bare send won't re-inherit it) and, if a
   * goal hook is currently registered for this engine, unregisters it so an
   * in-flight run can stop instead of being re-blocked by the now-cleared goal.
   * Returns true if a goal was actually cleared. Idempotent — clearing a
   * session with no active goal is a no-op returning false.
   */
  clearGoal(sessionId: string): boolean {
    if (!this.sessionManager.exists(sessionId)) return false;
    const session = this.sessionManager.resume(sessionId);
    const had = session.state.activeGoal !== undefined;
    if (had) {
      session.state.activeGoal = undefined;
      this.sessionManager.saveState(session.state);
    }
    // If THIS session's goal run is in flight, drop its stop hook so the
    // current run can terminate (the closure-held goal would otherwise keep
    // re-blocking). The run's own `finally` also unregisters; double-unregister
    // is safe (set delete is idempotent).
    if (this.activeGoalHook && this.lastSessionId === sessionId) {
      this.hooks.unregister("on_stop", this.activeGoalHook);
      this.activeGoalHook = null;
    }
    return had;
  }

  injectContext(sessionId: string, content: string): void {
    const session = this.sessionManager.resume(sessionId);
    session.transcript.appendMessage("assistant", content);

    // Keep the compacted cache in sync so the next engine.run() call
    // (which reads from compactedMessagesBySession first) sees the
    // injected content rather than a stale pre-inject snapshot.
    const cached = this.compactedMessagesBySession.get(sessionId);
    if (cached) {
      cached.push({ role: "assistant", content });
    }
  }

  /**
   * Force context compaction on the current session.
   * Returns token stats before/after.
   */
  forceCompact(): { before: number; after: number; strategy: string } {
    const sessionId = this.lastSessionId;
    if (!this.lastContextManager || !sessionId) {
      return { before: 0, after: 0, strategy: "none (no active session)" };
    }
    const sourceMessages =
      this.compactedMessagesBySession.get(sessionId) ??
      this.sessionManager.resume(sessionId).transcript.toMessages();
    const before = estimateTokens(sourceMessages);
    const compacted = this.lastContextManager.manage(sourceMessages);
    const after = estimateTokens(compacted);
    this.compactedMessagesBySession.set(sessionId, compacted);
    this.lastMessages = compacted;
    return {
      before,
      after,
      strategy: before === after ? "no compaction needed" : "compacted",
    };
  }

  private stripUserContextMessage(messages: Message[], userContextMsg: Message | null): Message[] {
    if (!userContextMsg || messages[0] !== userContextMsg) {
      return [...messages];
    }
    return messages.slice(1);
  }

  private getSettingsManager(): SettingsManager {
    if (!this.settingsManager) {
      this.settingsManager = new SettingsManager(
        this.config.cwd,
        this.config.settingsScope ?? "project",
      );
    }
    return this.settingsManager;
  }

  /**
   * Update a config setting at runtime.
   */
  updateConfig(key: string, value: unknown): void {
    this.getSettingsManager().saveUserSetting(key, value);
  }

  /**
   * Read a settings value by dotted key (e.g. "arena.participants").
   * Returns undefined if any segment is missing.
   */
  readSetting(key: string): unknown {
    const settings = this.getSettingsManager().get() as Record<string, any>;
    const parts = key.split(".");
    let target: any = settings;
    for (const p of parts) {
      if (target == null || typeof target !== "object") return undefined;
      target = target[p];
    }
    return target;
  }

  private buildPermissionConfig(
    mode: NonNullable<EngineConfig["permissionMode"]>,
    cwd: string,
  ): { rules: import("../types.js").PermissionRule[]; backend: ApprovalBackend } {
    const rules: import("../types.js").PermissionRule[] = [...this.preset.defaultPermissionRules];

    // Memory tools: dream scope is the LLM's own workspace, so save/delete
    // there go through without prompting. user-scope save/delete fall through
    // to the tool's permissionDefault ("ask"), forcing the user to confirm
    // any modification of memories they own. Read tools are listed in the
    // tool definition as permissionDefault: "allow" — no rule needed here.
    rules.push({
      tool: "MemorySave",
      argsPattern: { scope: "^dream$" },
      decision: "allow",
      reason: "Dream scope is the LLM's auto-consolidation workspace",
    });
    rules.push({
      tool: "MemoryDelete",
      argsPattern: { scope: "^dream$" },
      decision: "allow",
      reason: "Dream scope is the LLM's auto-consolidation workspace",
    });

    if (mode === "acceptEdits" || mode === "bypassPermissions") {
      rules.push({ tool: "Write", decision: "allow" });
      rules.push({ tool: "Edit", decision: "allow" });
    }
    if (mode === "bypassPermissions") {
      rules.push({ tool: "Bash", decision: "allow" });
    }

    try {
      const settingsManager = new SettingsManager(cwd, this.config.settingsScope ?? "project");
      const settings = settingsManager.get();
      if (settings.permissions?.rules?.length) {
        rules.unshift(...settings.permissions.rules);
      }
    } catch {
      // Settings not available — defaults only
    }

    let backend: ApprovalBackend;
    if (this.config.approvalBackend) {
      backend =
        mode === "auto"
          ? new AutoApprovalBackend(this.config.approvalBackend)
          : this.config.approvalBackend;
    } else if (mode === "auto") {
      backend = new AutoApprovalBackend();
    } else {
      // If a host installed an InteractiveApprovalBackend prompt fn
      // (agent-server-stdio does this on boot via setInteractiveApprovalFn),
      // use it so the UI gets a chance to approve/deny. Without this,
      // every `ask` permission silently fell through to deny-all and
      // the user saw "Permission denied by user" with NO modal — exactly
      // the bug that motivated this fix.
      const interactive = getInteractiveApprovalBackend();
      if (interactive.hasPromptFn()) {
        backend = interactive;
      } else {
        backend = new HeadlessApprovalBackend(
          mode === "bypassPermissions" ? "approve-all" : mode === "dontAsk" ? "deny-all" : "deny-all",
        );
      }
    }
    return { rules, backend };
  }

  /**
   * Switch permission mode at runtime. Takes effect immediately for any
   * in-flight ToolExecutor (which holds a reference to the same classifier),
   * and the new mode is used for any subsequent run() calls.
   * Session-only — does not persist to settings.
   */
  setPermissionMode(mode: NonNullable<EngineConfig["permissionMode"]>): void {
    this.config = { ...this.config, permissionMode: mode };
    this.permissionMode = mode;
    this.planMode = mode === "plan";
    if (this.activePermission) {
      const cwd = this.config.cwd ?? process.cwd();
      const { rules, backend } = this.buildPermissionConfig(mode, cwd);
      this.activePermission.reconfigure(mode, backend, rules);
    }
  }

  getPermissionMode(): NonNullable<EngineConfig["permissionMode"]> {
    return this.config.permissionMode ?? "acceptEdits";
  }

  /**
   * Extend the in-flight run's turn ceiling and/or goal budgets (TODO 3.1 —
   * 运行中续轮/加预算). No-op (returns null) when no run is active. Lets a user
   * keep an unattended goal going past its original cap instead of restarting.
   */
  extendGoalRun(
    opts: GoalExtension,
  ): { maxTurns: number; tokenBudget?: number; timeBudgetMs?: number; maxStopBlocks: number } | null {
    if (!this.activeTurnLoop) return null;
    return this.activeTurnLoop.extend(opts);
  }

  /**
   * The effective permission rules for the current mode + cwd (TODO 5.1) —
   * preset defaults + mode-derived + settings.permissions.rules, in the same
   * order the classifier evaluates them. Exposed read-only so `/permissions`
   * (and any UI) can list what's actually in force. Pure read; builds the same
   * rule set buildPermissionConfig does, without constructing a backend.
   */
  getPermissionRules(): import("../types.js").PermissionRule[] {
    return this.buildPermissionConfig(this.getPermissionMode(), this.config.cwd ?? process.cwd()).rules;
  }

  /**
   * Toggle plan mode directly. Called by the Plan tool (Task 7) via ToolContext.engine.
   * Also syncs permissionMode to keep both fields consistent.
   */
  setPlanMode(value: boolean): void {
    if (value) {
      this.setPermissionMode("plan");
    } else if (this.permissionMode === "plan") {
      // Leaving plan mode: drop back to the default.
      this.setPermissionMode("acceptEdits");
    } else {
      this.planMode = value;
    }
  }

  /**
   * Block until a background agent's state changes (finishes / its result is
   * enqueued) or `signal` aborts. Resolves `true` if aborted, `false` on a
   * change. The caller re-checks `hasRunningForSession` after each wake, so a
   * spurious wake (another session's agent) just loops again.
   *
   * Subscribes to BOTH the registry AND the notification queue — and that's
   * load-bearing, not belt-and-suspenders. A completing agent calls
   * `markCompleted` (registry notify) and only THEN `enqueue` (queue notify),
   * as two separate statements. If we woke on the registry notify alone, the
   * loop could re-check, see no running agents, and `drainAll` BEFORE the
   * result was enqueued — silently losing the last agent's output. Waking on
   * the queue notify guarantees the item is already in the bucket. But a
   * *cancelled* agent marks-but-never-enqueues (by design), so we also need
   * the registry notify or a final cancel would hang the wait forever. Hence
   * both. Subscribe-before-await closes the check/wait race either way.
   */
  private waitForBackgroundAgentChange(
    _sessionId: string,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (aborted: boolean) => {
        if (settled) return;
        settled = true;
        unsubRegistry();
        unsubQueue();
        signal?.removeEventListener("abort", onAbort);
        resolve(aborted);
      };
      const onAbort = () => finish(true);
      const unsubRegistry = asyncAgentRegistry.subscribe(() => finish(false));
      const unsubQueue = notificationQueue.subscribe(() => finish(false));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Like waitForBackgroundAgentChange but with no abort signal and a hard
   * timeout. Resolves `true` on a registry/queue change, `false` if `timeoutMs`
   * elapses first. Used only by the headless abort-drain cleanup, where we want
   * to catch a completing agent's just-about-to-enqueue notification without
   * risking a permanent hang on an agent that never completes.
   */
  private waitForBackgroundAgentChangeOrTimeout(
    _sessionId: string,
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (changed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubRegistry();
        unsubQueue();
        resolve(changed);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      const unsubRegistry = asyncAgentRegistry.subscribe(() => finish(true));
      const unsubQueue = notificationQueue.subscribe(() => finish(true));
    });
  }

  /**
   * Sub-agent role registry for the given cwd, memoized per-cwd so the
   * directory is read once rather than every turn. A new cwd (e.g. via
   * run({ cwd })) reloads.
   */
  private getAgentDefinitions(cwd: string): AgentDefinitionRegistry {
    const disabledAgents = this.readDisabledAgents(cwd);
    const disabledPlugins = this.readDisabledLists().disabledPlugins;
    const disabledKey = [...disabledAgents, "::", ...disabledPlugins]
      .slice()
      .sort()
      .join(" ");
    if (
      this.agentDefsCache?.cwd !== cwd ||
      this.agentDefsCache.disabledKey !== disabledKey
    ) {
      this.agentDefsCache = {
        cwd,
        disabledKey,
        reg: loadAgentDefinitionsForCwd(cwd, disabledAgents, disabledPlugins),
      };
    }
    return this.agentDefsCache.reg;
  }

  /**
   * Read settings.disabledAgents, folded with the project's
   * capabilityOverrides.agents overlay for `cwd`. Unlike disabledSkills,
   * sub-agents do NOT skip this — a disabled role must stay invisible
   * everywhere. The overlay lets a project force-enable a globally-disabled
   * role or force-disable a globally-enabled one (tri-state); read UNMERGED
   * (getForScope) so inherit survives. No cwd / no overlay → baseline
   * unchanged. Mirrors readDisabledLists (skills/plugins).
   */
  private readDisabledAgents(cwd?: string): string[] {
    try {
      const sm = this.getSettingsManager();
      const settings = sm.get() as { disabledAgents?: string[] };
      const baseline = Array.isArray(settings.disabledAgents) ? settings.disabledAgents : [];
      const overrides = cwd
        ? (sm.getForScope("project", cwd).capabilityOverrides as CapabilityOverrides | undefined)
        : undefined;
      return effectiveDisabledList(baseline, overrides?.agents);
    } catch {
      return [];
    }
  }

  /**
   * Read the project's capabilityOverrides.builtin bucket for `cwd`, read
   * UNMERGED (getForScope) so tri-state inherit survives. Sub-agents skip the
   * overlay (minimal surface, same as readDisabledLists) — their builtin lists
   * are already narrowed by resolveChildToolScope. No cwd / error → undefined,
   * so the caller's baseline builtin lists pass through unchanged.
   */
  private readBuiltinOverride(
    cwd?: string,
  ): Record<string, CapabilityOverride> | undefined {
    if (this.config.isSubAgent === true || !cwd) return undefined;
    try {
      const overrides = this.getSettingsManager().getForScope("project", cwd)
        .capabilityOverrides as CapabilityOverrides | undefined;
      return overrides?.builtin;
    } catch {
      return undefined;
    }
  }

  /**
   * Build a base ToolContext for this Engine. Used by run() (which then
   * overlays turn-specific fields like sandbox and subAgentSpawner) and
   * by tests that want a ToolContext without a full run() cycle.
   */
  private resolveSandboxWithoutRuntime(
    config: SandboxConfig,
    cwd: string,
  ): Promise<SandboxBackend> {
    const key = sandboxCacheKey(config, cwd);
    let cached = this.sandboxCache.get(key);
    if (!cached) {
      cached = resolveSandboxBackend(config, cwd);
      // Mirror EngineRuntime.resolveSandbox: don't cache a rejection, or an
      // explicit-mode probe that throws stays sticky until process restart even
      // after the user fixes the config.
      cached.catch(() => {
        if (this.sandboxCache.get(key) === cached) this.sandboxCache.delete(key);
      });
      this.sandboxCache.set(key, cached);
    }
    return cached;
  }

  /**
   * Build the shell env layered onto the Bash tool / background shells (see
   * mergeShellEnv). Three user-configured sources, merged lowest → highest:
   *
   *   1. project `localEnvironment.env`  — the per-project "local environment"
   *      panel (DATABASE_URL etc.); the floor, so a project's own panel values
   *      can be overridden by an explicit top-level `env`.
   *   2. global top-level `env`          — ~/.code-shell/settings.json; the
   *      canonical home for API keys (OPENAI_API_KEY) a skill script reads —
   *      configure once, every project's skills get it.
   *   3. project top-level `env`         — .code-shell/settings.json; a project
   *      that wants to override a global key wins.
   *
   * Each scope is read UNMERGED so the layering here is the single source of
   * precedence (getForScope merges nothing). Sub-agents and no-cwd contexts
   * get nothing (same minimal surface as readBuiltinOverride). Returns
   * undefined when no layer contributes a key, so the caller passes it through
   * unchanged for projects that configure none.
   *
   * None of these is filtered through the deny regex (mergeShellEnv): the user
   * put them there deliberately. The allowlist/deny machinery only guards the
   * host's process.env from a tainted model exfiltrating it via `env | curl`.
   */
  private readShellEnv(cwd?: string): Record<string, string> | undefined {
    if (this.config.isSubAgent === true || !cwd) return undefined;
    const merged: Record<string, string> = {};
    const layer = (env: Record<string, string> | undefined): void => {
      if (!env) return;
      for (const [k, v] of Object.entries(env)) {
        if (typeof v === "string") merged[k] = v;
      }
    };
    try {
      // The fully-merged settings already apply the scope guard (a 'project'
      // scope never reads the host ~/.code-shell) and the user < project <
      // local precedence — so the top-level `env` map read from here is global
      // values overridden by project values, exactly as specified. We layer
      // localEnvironment.env *under* it as the floor.
      const settings = this.getSettingsManager().get() as {
        env?: Record<string, string>;
        localEnvironment?: { env?: Record<string, string> };
      };
      layer(settings.localEnvironment?.env); // floor
      layer(settings.env); // top-level env (global ⊕ project) wins
    } catch {
      return undefined;
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /**
   * Read the project's `localEnvironment.setupScripts` for this cwd (the raw
   * per-platform map). Used by EnterWorktree to run setup once in a freshly
   * created worktree. Returns undefined for sub-agents / no cwd (same minimal
   * surface as readShellEnv). The platform selection + run live in
   * git/worktree.ts; this only fetches the configured scripts.
   */
  readWorktreeSetupScripts(cwd?: string):
    | { default?: string; macos?: string; linux?: string; windows?: string }
    | undefined {
    if (this.config.isSubAgent === true || !cwd) return undefined;
    try {
      const scoped = this.getSettingsManager().getForScope("project", cwd) as {
        localEnvironment?: {
          setupScripts?: { default?: string; macos?: string; linux?: string; windows?: string };
        };
      };
      return scoped.localEnvironment?.setupScripts;
    } catch {
      return undefined;
    }
  }

  buildToolContext(): ToolContext {
    const { disabledSkills, disabledPlugins } = this.readDisabledLists();
    return {
      shellEnv: this.readShellEnv(this.config.cwd),
      cwd: this.config.cwd ?? process.cwd(),
      llmConfig: this.config.llm,
      modelPool: this.modelPool,
      toolRegistry: this.toolRegistry,
      askUser: this.config.askUser,
      browser: this.config.browserBridge,
      injectCredentialToBrowser: this.config.injectCredentialToBrowser,
      isSubAgent: this.config.isSubAgent === true,
      hooks: this.hooks,
      planMode: this.planMode,
      permissionMode: this.permissionMode,
      engine: this,
      disabledSkills,
      disabledPlugins,
      skillAllowlist: this.config.skillAllowlist,
      backgroundShells: backgroundShellManager,
      // Sub-agents never start background shells (they're short-lived and
      // their lifecycle ends with the parent turn); unattended automation
      // opts out via config. Otherwise allowed.
      allowBackgroundShells:
        this.config.isSubAgent === true ? false : this.config.allowBackgroundShells !== false,
    };
  }

  /**
   * Read settings.disabledSkills + settings.disabledPlugins in a single
   * pass. Sub-agents skip both for the same reason they skip
   * settings.hooks / plugin hooks (registerSettingsHooks at ~line 237):
   * they run with a minimal surface area. Defaults to [] for both
   * fields so callers don't have to null-check.
   *
   * Combined read avoids drift if settings change between two separate
   * reads — the prompt composer and the tool context will always see
   * the same snapshot.
   */
  private readDisabledLists(): {
    disabledSkills: string[];
    disabledPlugins: string[];
    disabledPluginHooks: string[];
  } {
    if (this.config.isSubAgent === true) {
      return { disabledSkills: [], disabledPlugins: [], disabledPluginHooks: [] };
    }
    // Shared folding (capability-control/disabled-lists.ts): project
    // capabilityOverrides over the global baseline + the no-repo whitelist
    // inversion. Extracted so the MCP merge consumers (engineFactory /
    // diskDefaultsFrom) fold identically — see that module's doc.
    return computeEffectiveDisabledLists(this.getSettingsManager(), this.config.cwd);
  }

  /**
   * Public view of the folded disabled lists, for hosts that need the
   * EFFECTIVE state (e.g. the protocol server's settings hot-reload rebuilds
   * the plugin-MCP merge per session — a project-level "on" must override the
   * global disabledPlugins there too).
   */
  getEffectiveDisabledLists(): { disabledSkills: string[]; disabledPlugins: string[] } {
    return this.readDisabledLists();
  }

  /**
   * Public: resolve every known feature flag to its effective boolean (the
   * settings overlay merged over the compiled-in defaults). Used by the
   * `config` protocol query so the `/features` command can list flag state.
   */
  getFeatureFlags(): Record<FeatureFlagName, boolean> {
    return resolveFeatureFlags(this.readFeatureFlags());
  }

  /**
   * Read the merged `settings.featureFlags` overlay for this cwd. Project
   * settings override user settings via the normal SettingsManager merge.
   * Returns undefined (→ all defaults) on any read error or for sub-agents,
   * so a flag check never throws and a child runs with default behavior.
   */
  private readFeatureFlags(): FeatureFlagOverrides | undefined {
    if (this.config.isSubAgent === true) return undefined;
    try {
      const settings = this.getSettingsManager().get() as {
        featureFlags?: Record<string, boolean>;
      };
      return settings.featureFlags as FeatureFlagOverrides | undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Read settings.memories ({ maxCount, maxAge, extractionModel, autoExtract }).
   * Returns undefined on any error or when absent, so the memory pipeline
   * falls back to its built-in defaults.
   */
  private readMemoriesConfig():
    | { maxCount?: number; maxAge?: number; extractionModel?: string; autoExtract?: boolean }
    | undefined {
    try {
      const settings = this.getSettingsManager().get() as {
        memories?: {
          maxCount?: number;
          maxAge?: number;
          extractionModel?: string;
          autoExtract?: boolean;
        };
      };
      return settings.memories;
    } catch {
      return undefined;
    }
  }

  /**
   * LLM client for memory extraction (TODO 8.1). Prefers
   * settings.memories.extractionModel when it names a valid pool model;
   * otherwise falls back to the aux client (which itself falls back to the
   * passed primary). Build failures fall back too — extraction is best-effort.
   */
  private async resolveExtractionClient(
    primaryClient: Awaited<ReturnType<typeof createLLMClient>>,
  ): Promise<Awaited<ReturnType<typeof createLLMClient>>> {
    const key = this.readMemoriesConfig()?.extractionModel;
    if (key) {
      const entry = this.modelPool.get(key);
      if (entry) {
        try {
          return await createLLMClient(
            this.modelPool.toLLMConfig(entry),
            this.config.clientDefaults,
          );
        } catch (err) {
          logger.warn("engine.extraction_model_build_failed", {
            extractionModel: key,
            error: (err as Error).message,
          });
        }
      } else {
        logger.warn("engine.extraction_model_missing", { extractionModel: key });
      }
    }
    return this.resolveAuxClient(primaryClient);
  }
}

/**
 * Builtin tool name → the feature flag that gates its visibility. A tool here
 * is hidden from the LLM when its flag resolves to false. Tools not listed are
 * unaffected. Kept beside the engine (not in builtin/index) because the flag
 * read needs the engine's scoped SettingsManager.
 */
const TOOL_FEATURE_FLAGS: ReadonlyMap<string, FeatureFlagName> = new Map([
  ["WebSearch", "web_search"],
  ["Bash", "shell_tool"],
]);

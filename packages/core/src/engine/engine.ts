/**
 * Engine — the main facade that wires all components together.
 */

import type {
  ClientDefaults,
  Message,
  SessionState,
  SessionWorkspace,
  StreamCallback,
  TaskInfo,
  TokenUsage,
} from "../types.js";
import { createLLMClient } from "../llm/client-factory.js";
import { ToolRegistry } from "../tool-system/registry.js";
import {
  queryExtensionModules,
  registerExtensionModules,
} from "../tool-system/capability-module.js";
import { readLastTodoSnapshot } from "../tool-system/builtin/task.js";
import { getMergedCatalog } from "../model-catalog/index.js";
import { modelEntriesFromConnections } from "./model-connections-pool.js";
import {
  cumulativeCacheHitRate,
  foldRunUsage,
  normalizeCumulativeUsageCounters,
  type CumulativeUsageCounters,
} from "../session/usage.js";
import {
  enqueueSteerItem,
  consumeSteerItems,
  removeSteerItem,
  type SteerItem,
} from "./steer-queue.js";
import { RunEnvironmentResolver } from "./run-environment.js";
import {
  BUILTIN_TOOLS,
  type BuiltinTool,
  type BuiltinToolExposure,
  type BuiltinToolFn,
  type BuiltinToolGuard,
} from "../tool-system/builtin/index.js";
import { asyncAgentRegistry, type LiveChildState } from "../tool-system/builtin/agent-registry.js";
import { backgroundShellManager } from "../runtime/background-shell.js";
import { notificationQueue } from "../tool-system/builtin/agent-notifications.js";
import { HookRegistry } from "../hooks/registry.js";
import type { HookEventName, HookResult } from "../hooks/events.js";
import type { HookHandler } from "../hooks/registry.js";
import { createGoalStopHook, type GoalJudgeRuntimeContext } from "../hooks/goal-stop-hook.js";
import {
  normalizeGoal,
  resolveMaxTurns,
  resolveMaxStopBlocks,
  goalConfigFromLifecycle,
  isGoalLifecycleCurrent,
  isSameGoalVersion,
  type GoalConfig,
  type GoalExtension,
  type GoalTerminationReason,
} from "../goal/lifecycle.js";
import { loadPluginHooks } from "../plugins/loadPluginHooks.js";
import { pluginAgentDirs } from "../plugins/installer/loadPluginAgents.js";
import { runShellHook, shellHookMatches } from "../hooks/shell-runner.js";
import { ContextManager, type CompactStrategy } from "../context/manager.js";
import {
  CONTEXT_PACKAGE_MAX_OUTPUT_TOKENS,
  buildContextPackagePromptFromSerialized,
  estimateTokens,
  groupMessagesByApiRound,
  serializeContextPackageMessages,
  clampContextRatios as clampContextRatiosImpl,
} from "../context/compaction.js";
import { PromptComposer } from "../prompt/composer.js";
import {
  SessionManager,
  sessionsRoot,
  type ForkSessionOptions,
  type ForkSessionResult,
  type SummaryForkOptions,
  type SessionBundle,
  type SessionStateFieldPatch,
  type GoalTerminalSaveOutcome,
} from "../session/session-manager.js";
import { createRunUsageAccounting, wireRunModelFacade } from "./run-accounting.js";
import { logger, runWithSid } from "../logging/logger.js";
import { recordSessionStart } from "../logging/session-recorder.js";
import { sanitizeTaskString } from "../logging/sanitize-messages.js";
import { TurnLoop } from "./turn-loop.js";
import type { AskUserFn } from "../tool-system/builtin/ask-user.js";
import { MCPManager } from "../tool-system/mcp-manager.js";
import { SettingsManager, userHome } from "../settings/manager.js";
import { getCredentialAccess } from "../credentials/access.js";
import type { CapabilityOverride, CapabilityOverrides } from "../settings/schema.js";
import {
  resolveFeatureFlags,
  type FeatureFlagName,
  type FeatureFlagOverrides,
} from "../settings/feature-flags.js";
import {
  effectiveBuiltinLists,
  effectiveDisabledList,
  effectiveProjectOverrides,
} from "../capability-control/overlay.js";
import { computeEffectiveDisabledLists } from "../capability-control/disabled-lists.js";
import { registerFileHistoryHook } from "./file-history-hook.js";
import type { ToolContext } from "../tool-system/context.js";
import { resolveAgentPreset, resolveBuiltinToolNames, type AgentPreset } from "../preset/index.js";
import {
  composeDynamicContextProviders,
  composeCapabilityEngineHooks,
  composePromptSections,
  composeToolCatalog,
  resolveCapabilities,
  resolveInstructionBoundary,
  type CapabilityDynamicContextProvider,
  type CapabilityModule,
} from "../capabilities/index.js";
import { ModelPool, type ModelEntry } from "../llm/model-pool.js";
import { AgentDefinitionRegistry } from "../agent/agent-definition-registry.js";
import { defaultCacheDir } from "../llm/model-cache.js";
import { detectProviderFromApiKey, buildModelPool } from "../onboarding.js";
import { detectPastedNoise } from "../utils/task-sanitizer.js";
import {
  PromptCacheDiagnosticRecorder,
  promptCacheDropHint,
  type PromptCacheDiagnosticSample,
} from "./prompt-cache-diagnostics.js";
import { EngineRuntime } from "./runtime.js";
import { buildRunUserMessageContent, prepareRunImageInput } from "./run-image-input.js";
import {
  QUICK_CHAT_RESTRICTED_PROFILE,
  type EngineRunOptions,
  type RunBehaviorProfile,
} from "./run-types.js";
import { createSubAgentSpawner } from "./subagent-spawner.js";
import { AuxiliaryPipeline, sameLlmIdentity } from "./auxiliary-pipeline.js";
import { PermissionController } from "./permission-controller.js";
import { buildPromptComposerConfig } from "./run-setup.js";
import { resolveRunWorkspace } from "./run-workspace.js";
import { openRunSession } from "./run-session-open.js";
import {
  buildRunToolContext,
  buildRunPermissionPipeline,
  connectRunMcp,
  assembleRunToolDefs,
} from "./run-tooling.js";
import {
  createRunContextManager,
  composeRunSystemPrompt,
  assembleRunMessages,
} from "./run-context.js";
import {
  resolveRunGoal,
  armRunGoalHook,
  createGoalTerminationApplier,
  type GoalRunSlots,
} from "./run-goal.js";
import {
  drainHeadlessBackgroundAgents,
  finalizeRunSuccess,
  buildRunFailureResult,
} from "./run-finalize.js";
import { join } from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { InputAttachmentMeta } from "../types.js";

/**
 * Build ScanOptions.compatFileNames from the user's instruction compat toggles.
 * Primary file name stays hard-wired to CODESHELL.md (not exposed). Turning a
 * compat flag off only drops the same-named .md (CLAUDE.md / AGENTS.md); the
 * .claude/ subdir, *.local.md and rules/ are intentionally NOT linked.
 * undefined (instructions omitted) means both stay on — backward compatible.
 */
export function compatFileNamesFrom(instructions?: {
  compatClaude?: boolean;
  compatCodex?: boolean;
}): string[] {
  const names: string[] = [];
  if (instructions?.compatClaude !== false) names.push("CLAUDE.md");
  if (instructions?.compatCodex !== false) names.push("AGENTS.md");
  return names;
}

// EngineConfig / EngineHookConfig / EngineResult now live in engine/types.ts
// so type-only consumers (protocol server, run factory, product layer,
// engine/disk-defaults, SDK index) can import them without dragging in this
// 3000-line implementation. Re-exported here for back-compat — existing
// `import { EngineConfig } from ".../engine/engine.js"` keeps working.
export type { EngineConfig, EngineHookConfig, EngineResult } from "./types.js";
import type { EngineConfig, EngineResult } from "./types.js";

export interface EnqueueSteerResult {
  accepted: boolean;
  id: string;
}

// Re-export the config hot-reload patch builder from here so the protocol
// server (and tests) can import it alongside Engine without reaching into the
// settings/ subtree directly. The implementation lives in settings/ to keep
// engine.ts from growing and to sit next to personalizationFrom it composes.
export { diskDefaultsFrom, type DiskDefaultPatch } from "./disk-defaults.js";

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
export { resolveChildLlm, resolveChildToolScope } from "./subagent-spawner.js";

// resolveRunCwd moved to run-workspace.ts; re-exported here so
// engine.resolve-cwd.test.ts keeps resolving it from engine.js unchanged.
export { resolveRunCwd } from "./run-workspace.js";

/**
 * Load reusable sub-agent role definitions, merging:
 *   1. project-level  <cwd>/.code-shell/agents/*.md   (ships built-ins)
 *   2. user-level     ~/.code-shell/agents/*.md        (user wins on name)
 * Names in `disabledAgents` are filtered out so the LLM never sees them.
 */

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
export class Engine {
  // Resolved per-session preset. Set in the ctor; re-resolved by
  // refreshRuntimeConfig on a preset hot-reload so the next-turn PromptComposer
  // picks up the new preset's system prompt / behavior (#2). NOT readonly for
  // that reason. NOTE: the toolRegistry's builtin tool SET is still ctor-frozen
  // and is NOT rebuilt on reload — a preset change that alters the builtin tool
  // set only takes effect on session restart (logged in refreshRuntimeConfig).
  private preset: AgentPreset;
  /** Capability-free seed owned by the runtime/host; never mutated by an Engine. */
  private runtimeToolRegistry: ToolRegistry;
  /** Engine-local view containing only this Engine's capability modules. */
  private toolRegistry: ToolRegistry;
  private readonly capabilities: readonly CapabilityModule[];
  private readonly toolCatalog: readonly BuiltinTool[];
  private readonly toolGuards: ReadonlyMap<string, BuiltinToolGuard>;
  /** Per-turn dynamic definition rewriters contributed by builtin exposures. */
  private readonly toolRewriters: ReadonlyMap<
    string,
    NonNullable<BuiltinToolExposure["rewriteDefinition"]>
  >;
  /** Named per-run behavior profiles (core defaults + config + extensions). */
  private readonly behaviorProfiles: ReadonlyMap<string, RunBehaviorProfile>;
  private readonly capabilityPromptSections: Readonly<Record<string, string>>;
  private readonly capabilityDynamicContextProviders: readonly CapabilityDynamicContextProvider[];
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
  private readonly runEnvironmentResolver: RunEnvironmentResolver;
  private readonly auxiliaryPipeline: AuxiliaryPipeline;
  private readonly permissionController: PermissionController;

  // Lazy SettingsManager — reused across updateConfig/readSetting so we
  // don't re-read 6+ JSON files on every /model, /login, etc. The manager
  // handles its own cache invalidation in saveUserSetting().
  private settingsManager: SettingsManager | undefined;

  // Live state from the current/most-recent run, retained for /compact and
  // run-boundary PermissionClassifier replacement/reconfiguration.
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
  private promptCacheDiagnostics = new PromptCacheDiagnosticRecorder({ maxSessions: 256 });
  /**
   * Step-gap steering queue (per sessionId, in-memory). Host pushes user
   * messages here via enqueueSteer while a run is in flight; the turn loop
   * drains it at each step boundary and splices them into the next LLM request
   * WITHOUT aborting (the 不打断 path, vs cancel+resend). Pure memory, forgotten
   * on process exit — same model as the credential session-allow set, so
   * multiple Engines don't interfere and it stays cleanly extractable.
   */
  private steerQueueBySid = new Map<string, SteerItem[]>();
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
  /** Whether activeGoalHook is currently registered (pause detaches it). */
  private activeGoalHookAttached = false;
  /** Mutable goal view consumed by the running judge after edits/resume. */
  private activeRuntimeGoal: GoalConfig | null = null;
  /** Mutable terminal snapshot kept in sync with a mid-run objective edit. */
  private activePersistedRunGoal: GoalConfig | null = null;
  /**
   * The in-flight run's session bundle, held so clearGoal() can wipe the goal
   * on the SAME instance the run loop is persisting each turn — not a fresh
   * detached copy from resume(). Without this, a mid-run 清除 clears disk, but
   * the still-running loop's next saveState(bundle.state) resurrects the goal
   * (bundle.state.goalLifecycle was never rebased). A never-completing goal run
   * (judge keeps returning not_met → continueSession) stays live for a long
   * time, so this write-back race is the norm, not an edge case, for such runs.
   * Single-valued like activeTurnLoop — one top-level run per engine at a time.
   * Null when idle; set at run start, cleared in run's finally.
   */
  private activeRunSession: SessionBundle | null = null;
  /**
   * Same-instance run guard. Engine owns single-valued live controls and one
   * HookRegistry, so a second run must not enter until the first has completed
   * all state persistence and end hooks. Cross-instance/process whole-state
   * writers are additionally fenced by SessionManager's persisted revision CAS.
   */
  private runInProgress = false;
  private agentControlStateListener?: (state: LiveChildState) => void;
  private agentDirectionsDeliveredListener?: (envelopeIds: string[]) => void;
  /** Permission update requested while runInProgress. Applied in run() finally. */

  /** Public accessor so UI/clients can read the resolved per-model window. */
  get maxContextTokens(): number {
    return this.resolveMaxContextTokens();
  }

  private resolveMaxContextTokens(): number {
    const modelEntry = this.modelPool
      .list()
      .find((entry) => sameLlmIdentity(this.modelPool.toLLMConfig(entry), this.config.llm));
    return (
      this.config.llm.maxContextTokens ??
      modelEntry?.maxContextTokens ??
      this.config.maxContextTokens ??
      200_000
    );
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
    signal?: AbortSignal,
  ): Promise<HookResult> {
    return this.hooks.emit(event, {
      ...data,
      isSubAgent: this.config.isSubAgent === true,
      signal,
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
      this.hooks.register(event, handler, 50, `shell:${entry.event}:${entry.command.slice(0, 32)}`);
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
    // Also drop & re-load plugin hooks. Plugin hooks are registered under
    // `plugin:<name>:<event>` names; without this, disabling a plugin
    // mid-session left its hooks firing until the next new session (asymmetric
    // with settings-hook hot-reload). Re-reading readDisabledLists means a
    // now-disabled plugin's hooks are simply not re-registered.
    this.hooks.removeByNamePrefix("plugin:");
    try {
      const { disabledPlugins, disabledPluginHooks } = this.readDisabledLists();
      loadPluginHooks(this.hooks, disabledPlugins, disabledPluginHooks);
    } catch {
      // best-effort — a plugin-load failure must not break settings reload below
    }
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
    this.runEnvironmentResolver = new RunEnvironmentResolver({
      config: () => this.config,
      settings: () => this.getSettingsManager(),
      credentialAccess: {
        envExposures: (cwd, scope) => getCredentialAccess().envExposures(cwd, scope),
      },
      ...(this.runtime ? { runtime: this.runtime } : {}),
    });

    this.capabilities = resolveCapabilities(config.capabilities);
    this.config = { ...config, capabilities: this.capabilities };
    this.toolCatalog = composeToolCatalog(
      BUILTIN_TOOLS,
      this.capabilities,
      config.extensionModules ?? [],
    );
    this.toolGuards = new Map(
      this.toolCatalog.flatMap((tool) =>
        tool.exposure.availability
          ? ([[tool.definition.name, tool.exposure.availability]] as const)
          : [],
      ),
    );
    this.toolRewriters = new Map(
      this.toolCatalog.flatMap((tool) =>
        tool.exposure.rewriteDefinition
          ? ([[tool.definition.name, tool.exposure.rewriteDefinition]] as const)
          : [],
      ),
    );
    // Behavior profile registry: core defaults first, then host config, then
    // extension modules — later registrations override earlier ones by id.
    this.behaviorProfiles = new Map(
      [
        QUICK_CHAT_RESTRICTED_PROFILE,
        ...(config.behaviorProfiles ?? []),
        ...(config.extensionModules ?? []).flatMap((module) => module.behaviorProfiles ?? []),
      ].map((profile) => [profile.id, profile] as const),
    );
    this.capabilityPromptSections = composePromptSections(this.capabilities);
    this.capabilityDynamicContextProviders = composeDynamicContextProviders(this.capabilities);
    this.preset = resolveAgentPreset(config.preset, this.capabilities);
    // Extension catalogTools join the active preset regardless of its name:
    // presets snapshot their tool lists from the catalogs known at module
    // load, which can never include extension packages. Visibility stays
    // gated by each tool's exposure.availability guard.
    const extensionCatalogTools = (config.extensionModules ?? []).flatMap((module) => [
      ...(module.catalogTools ?? []),
    ]);
    if (extensionCatalogTools.length > 0) {
      this.preset = {
        ...this.preset,
        builtinTools: [
          ...this.preset.builtinTools,
          ...extensionCatalogTools.map((tool) => tool.definition.name),
        ],
        defaultPermissionRules: [
          ...this.preset.defaultPermissionRules,
          ...extensionCatalogTools.flatMap((tool) => [
            ...(tool.exposure.defaultPermissionRules ?? []),
          ]),
        ],
      };
    }
    this.permissionController = new PermissionController({
      config: () => this.config,
      updateConfig: (next) => {
        this.config = next;
      },
      presetRules: () => [...this.preset.defaultPermissionRules],
      runInProgress: () => this.runInProgress,
    });
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
    this.runtimeToolRegistry =
      config.runtime?.toolRegistry ??
      new ToolRegistry({
        builtinTools: resolveBuiltinToolNames({
          preset: this.preset.name,
          host: config.builtinToolHost,
          enabledBuiltinTools: [
            ...builtinLists.enabledBuiltinTools,
            // Extension catalogTools are preset-agnostic (see preset merge
            // above); their availability guards gate actual visibility.
            ...extensionCatalogTools.map((tool) => tool.definition.name),
          ],
          disabledBuiltinTools: builtinLists.disabledBuiltinTools,
          capabilities: this.capabilities,
        }),
        toolCatalog: this.toolCatalog,
      });
    this.toolRegistry = this.runtimeToolRegistry.fork();
    registerExtensionModules(this.toolRegistry, config.extensionModules ?? []);
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
    // plugin (80) → shell (50) → capability (20) → SDK code (default 0).
    this.registerSettingsHooks();
    for (const hook of composeCapabilityEngineHooks(this.capabilities)) {
      this.hooks.register(hook.event, hook.handler, hook.priority, hook.name);
    }
    for (const hook of config.hooks ?? []) {
      this.hooks.register(hook.event, hook.handler, hook.priority, hook.name);
    }
    this.sessionManager = new SessionManager(
      config.sessionStorageDir,
      this.capabilities
        .map((capability) => capability.sessionWorkspace)
        .find((candidate) => candidate !== undefined),
    );

    // Initialize model pool — prefer runtime's shared pool, fall back to self-constructed.
    this.modelPool = config.runtime?.modelPool ?? new ModelPool();
    this.auxiliaryPipeline = new AuxiliaryPipeline({
      config: () => this.config,
      settings: () => this.getSettingsManager(),
      modelPool: () => this.modelPool,
      toolRegistry: () => this.toolRegistry,
      toolContext: () => this.buildToolContext(),
    });
    if (!config.runtime) {
      this.populateModelPoolFromSettings();
    }
  }

  /**
   * Load modelConnections[] from settings into the active ModelPool and
   * resync this.config.llm with the matching entry. Called from the ctor and
   * from reloadModelPool() (e.g. after onboarding writes new entries to disk).
   */
  private populateModelPoolFromSettings(): void {
    try {
      const sm = this.getSettingsManager();
      sm.invalidate();
      const settings = sm.get();

      // Unified model catalog (统一模型接入方案 §6): register text
      // connections from settings.modelConnections[] into the pool — the
      // catalog-driven instance store is the sole source of model selection.
      // A connection's instance id becomes its pool key. See
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

      if (hasConnections) {
        this.modelPool.setCacheDir(defaultCacheDir());
        this.modelPool.reloadCachedContextWindows();
        // Resolve the active entry from settings.defaults.text, then switch the
        // pool and write the resolved entry's credentials into config.llm, so the
        // first run() uses the right endpoint instead of whatever env-derived
        // fallback repl.ts seeded earlier.
        // Sub-agents skip this resync: their llm is chosen by the parent's
        // resolveChildLlm (per-role model routing). defaults.text is the *user's*
        // current UI model selection and must not clobber a child's routed model —
        // without this guard a role's `model: flash` is silently overridden back
        // to whatever the user has active in the foreground.
        if (this.config.isSubAgent !== true) {
          const defaultText = (settings as { defaults?: { text?: string } }).defaults?.text;
          // 统一 catalog only:defaults.text 命中则用;否则回退首个已注册连接,
          // 避免选未配置模型时静默沿用空种子(旧 bug:抛误导性 OPENAI_API_KEY missing)。
          let matchKey: string | undefined;
          if (defaultText && this.modelPool.list().some((e) => e.key === defaultText)) {
            matchKey = defaultText;
          } else {
            matchKey = this.modelPool.list()[0]?.key;
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
        // Auto-populate pool from the configured API key when no
        // modelConnections[] are configured. This lets users who only have an
        // env/seed API key still use /model to switch between the provider's
        // available models.
        this.autoPopulatePool(this.config.llm.apiKey, this.config.llm.baseUrl);
      }

      // Carry image-attachment settings + sampling temperature into
      // clientDefaults. Both are cross-model knobs — they apply to whatever
      // model is currently active and survive hot-switches. (Pre-cleanup
      // these were merged into llm.imageDetail / llm.temperature; that path
      // is gone because hot-switching now rotates llm wholesale.)
      const imageSettings = (
        settings as {
          images?: { detail?: "low" | "standard" | "high" | "original" };
        }
      ).images;
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
   * writes new modelConnections[] to disk so the running engine picks them
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
   * Auto-populate the model pool when no modelConnections[] are configured but
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

  /** Dispatch a host-installed capability query without teaching core its name. */
  queryCapability(
    type: string,
    params: Readonly<Record<string, unknown>> = {},
  ): Promise<{ handled: false } | { handled: true; data: unknown }> {
    return queryExtensionModules(this.config.extensionModules ?? [], type, params);
  }

  /**
   * Inject the askUser handler after construction. Used by AgentServer
   * to wire its protocol-backed askUser into an Engine that was created
   * before the server existed (chicken-and-egg: server takes engine in ctor).
   */
  setAskUser(fn: AskUserFn | undefined): void {
    this.config.askUser = fn;
  }

  /** Internal child-runtime seam used by the single-writer supervisor. */
  setAgentControlStateListener(listener: ((state: LiveChildState) => void) | undefined): void {
    this.agentControlStateListener = listener;
  }

  setAgentDirectionsDeliveredListener(
    listener: ((envelopeIds: string[]) => void) | undefined,
  ): void {
    this.agentDirectionsDeliveredListener = listener;
  }

  /**
   * Inject the browser automation bridge after construction (same chicken-and-egg
   * as setAskUser: the desktop host builds the bridge — which drives a webview —
   * after the Engine exists). Undefined → the browser_* tools degrade with a
   * clear "no browser panel" error.
   */
  setBrowserBridge(
    bridge: import("../tool-system/browser-bridge.js").BrowserBridge | undefined,
  ): void {
    this.config.browserBridge = bridge;
  }

  /** Inject the host-backed workspace bridge after construction. */
  setWorkspaceBridge(
    bridge: import("../tool-system/workspace-bridge.js").WorkspaceBridge | undefined,
  ): void {
    this.config.workspaceBridge = bridge;
  }

  /** Inject the host-backed panel discovery/focus bridge after construction. */
  setPanelBridge(
    bridge: import("../tool-system/panel-bridge.js").PanelHostBridge | undefined,
  ): void {
    this.config.panelBridge = bridge;
  }

  /**
   * Queue a user message to be spliced into the in-flight run for `sessionId`
   * at the next turn-loop step boundary — the 不打断 steering path (vs cancel +
   * resend). General-purpose: any host path (UI 引导, future agent coordination,
   * external triggers) can call it. If no run is active for this session, reject
   * without queueing so the host can downgrade to a normal run immediately.
   * No-op on blank text.
   *
   * `id` is the host's stable queue-entry id. It rides through to the
   * `steer_injected` event (so the host can match the injected bubble back to
   * the queued draft) and is the handle `unsteer` uses to revoke a still-pending
   * entry. A blank id is tolerated but means the entry can't be revoked.
   */
  enqueueSteer(
    sessionId: string,
    text: string,
    id = "",
    clientMessageId?: string,
    attachments?: InputAttachmentMeta[],
  ): EnqueueSteerResult {
    const q = this.steerQueueBySid.get(sessionId) ?? [];
    const entryId = id || `steer-${q.length}`;
    if (!sessionId) return { accepted: false, id: entryId };
    const activeRunSessionId = this.activeRunSession?.state.sessionId;
    const active = this.activeTurnLoop !== null && activeRunSessionId === sessionId;
    if (!active) {
      logger.info("steer.enqueue.idle_rejected", {
        sessionId,
        id: entryId,
        clientMessageId,
        attachmentCount: attachments?.length ?? 0,
        activeRunSessionId: activeRunSessionId ?? null,
        queueLength: q.length,
      });
      return { accepted: false, id: entryId };
    }
    const next = enqueueSteerItem(q, entryId, text, clientMessageId, attachments);
    if (next === q) return { accepted: false, id: entryId }; // blank text dropped
    this.steerQueueBySid.set(sessionId, next);
    logger.info("steer.enqueue.accepted", {
      sessionId,
      id: entryId,
      clientMessageId,
      attachmentCount: attachments?.length ?? 0,
      activeRunSessionId,
      queueLength: next.length,
    });
    return { accepted: true, id: entryId };
  }

  /**
   * Revoke a still-pending steer entry (the 撤回 path). Returns true if it was
   * removed, false if it was already consumed by the turn loop (can't take it
   * back — it has been spliced into the run).
   */
  unsteer(sessionId: string, id: string): boolean {
    const q = this.steerQueueBySid.get(sessionId);
    if (!q || q.length === 0) return false;
    const { list, removed } = removeSteerItem(q, id);
    if (removed) this.steerQueueBySid.set(sessionId, list);
    return removed;
  }

  /** Drain + clear the steer queue for a session (turn loop consumes per step). */
  private consumeSteer(
    sessionId: string,
    source: "normal_step" | "finalize_backfill" = "normal_step",
  ): SteerItem[] {
    const q = this.steerQueueBySid.get(sessionId);
    if (!q || q.length === 0) return [];
    const { drained, rest } = consumeSteerItems(q);
    this.steerQueueBySid.set(sessionId, rest);
    logger.info("steer.consume.drained", {
      sessionId,
      source,
      count: drained.length,
      ids: drained.map((item) => item.id),
      clientMessageIds: drained.flatMap((item) =>
        item.clientMessageId ? [item.clientMessageId] : [],
      ),
      queueLength: rest.length,
    });
    return drained;
  }

  /** Put failed steer preparation back ahead of messages queued while it was being prepared. */
  private restoreSteer(sessionId: string, items: SteerItem[]): void {
    if (items.length === 0) return;
    const queued = this.steerQueueBySid.get(sessionId) ?? [];
    this.steerQueueBySid.set(sessionId, [...items, ...queued]);
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

  get permissionMode(): NonNullable<EngineConfig["permissionMode"]> {
    return this.permissionController.permissionMode;
  }

  get planMode(): boolean {
    return this.permissionController.planMode;
  }

  /**
   * Probe whether a session already exists on disk (its state/transcript dir is
   * present). Used by the protocol server to distinguish "resume an existing
   * session" from "silently create a fresh empty one" — e.g. a cron resume job
   * whose target session the user deleted must fail loudly, not run its prompt
   * against a blank session. A stat probe, not a load.
   */
  sessionExistsOnDisk(sessionId: string): boolean {
    return this.sessionManager.exists(sessionId);
  }

  forkSession(sourceSessionId: string, options?: ForkSessionOptions): ForkSessionResult {
    return this.sessionManager.fork(sourceSessionId, options);
  }

  selectContextPackage(
    sourceSessionId: string,
    range: { fromEventId: string; toEventId: string },
  ): ReturnType<SessionManager["selectContextPackage"]> {
    return this.sessionManager.selectContextPackage(sourceSessionId, range);
  }

  createSummaryFork(sourceSessionId: string, options: SummaryForkOptions): ForkSessionResult {
    return this.sessionManager.createSummaryFork(sourceSessionId, options);
  }

  /** Summarize a selected transcript package using the configured aux tier. */
  async summarizeContextPackage(
    messages: Message[],
    signal?: AbortSignal,
    sourceSessionId?: string,
  ): Promise<{ summary: string; estimatedTokens: number }> {
    if (messages.length === 0) throw new Error("Cannot summarize an empty context package");
    const serializedSelection = serializeContextPackageMessages(messages);
    if (!serializedSelection.hasSummarizableContent) {
      throw new Error(
        "Cannot summarize an image-only context package without textual or tool facts",
      );
    }
    if (sourceSessionId && this.config.costStore) {
      const persistedCost = this.sessionManager.resume(sourceSessionId).state.costState;
      if (persistedCost) this.config.costStore.restore(persistedCost);
    }
    const primaryClient = await createLLMClient(this.config.llm, this.config.clientDefaults);
    const resolvedAux = await this.auxiliaryPipeline.resolveAuxClientWithMetadata(
      primaryClient,
      this.resolveMaxContextTokens(),
    );
    const client = resolvedAux.client;
    const systemPrompt =
      "You package selected conversation context. Be concise, factual, and complete.";
    const fitsAuxWindow = (conversation: string, priorSummary?: string): boolean => {
      const prompt = buildContextPackagePromptFromSerialized(conversation, priorSummary);
      const requestTokens = estimateTokens([
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ]);
      return requestTokens + CONTEXT_PACKAGE_MAX_OUTPUT_TOKENS <= resolvedAux.maxContextTokens;
    };
    if (!fitsAuxWindow("x")) {
      throw new Error(
        `Auxiliary model context window (${resolvedAux.maxContextTokens}) is too small for the context package template and output reserve`,
      );
    }

    // Preserve complete API rounds whenever they fit. If one round alone is
    // larger than the aux window, split its lossless serialized form and feed
    // every fragment through the same rolling nine-section merge.
    const pending = groupMessagesByApiRound(messages).map(
      (group) => serializeContextPackageMessages(group).text,
    );
    let summary: string | undefined;
    while (pending.length > 0) {
      let conversation = "";
      while (pending.length > 0) {
        const next = pending[0]!;
        const candidate = conversation ? `${conversation}\n${next}` : next;
        if (fitsAuxWindow(candidate, summary)) {
          conversation = candidate;
          pending.shift();
          continue;
        }
        if (conversation) break;

        let low = 1;
        let high = next.length;
        let fitLength = 0;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          if (fitsAuxWindow(next.slice(0, middle), summary)) {
            fitLength = middle;
            low = middle + 1;
          } else {
            high = middle - 1;
          }
        }
        if (fitLength === 0) {
          throw new Error(
            `Auxiliary model context window (${resolvedAux.maxContextTokens}) cannot fit the rolling context package prompt`,
          );
        }
        conversation = next.slice(0, fitLength);
        const remainder = next.slice(fitLength);
        if (remainder) pending[0] = remainder;
        else pending.shift();
        break;
      }
      const response = await client.createMessage({
        systemPrompt,
        messages: [
          {
            role: "user",
            content: buildContextPackagePromptFromSerialized(conversation, summary),
          },
        ],
        tools: [],
        maxTokens: CONTEXT_PACKAGE_MAX_OUTPUT_TOKENS,
        billingEnabled: true,
        requestVisible: false,
        reasoning: { mode: "off" },
        signal,
      });
      if (response.usage && sourceSessionId) {
        this.sessionManager.recordAuxiliaryUsage(
          sourceSessionId,
          response.usage,
          this.config.costStore?.serialize() as Record<string, unknown> | undefined,
        );
      }
      summary = response.text.trim();
      if (!summary) throw new Error("Context package summary was empty");
    }
    return {
      summary: summary!,
      estimatedTokens: estimateTokens([{ role: "user", content: summary! }]),
    };
  }

  /** Restore a cold Engine's configured model from persisted source state without resetting usage. */
  restoreSessionModel(sessionId: string): void {
    const state = this.sessionManager.resume(sessionId).state;
    if (this.config.llm.model === state.model && this.config.llm.provider === state.provider)
      return;
    const entry =
      this.modelPool
        .list()
        .find(
          (candidate) => candidate.model === state.model && candidate.provider === state.provider,
        ) ?? this.modelPool.list().find((candidate) => candidate.model === state.model);
    if (!entry) {
      throw new Error(`Persisted source model is no longer configured: ${state.model}`);
    }
    this.config = { ...this.config, llm: this.modelPool.toLLMConfig(entry) };
  }

  /**
   * Run a task from start to finish. Rejects immediately when this Engine
   * instance already has a run in progress; hosts that want queueing own that
   * policy (for example ChatSession's FIFO queue).
   */
  async run(task: string, options?: EngineRunOptions): Promise<EngineResult> {
    if (this.runInProgress) {
      throw new Error("Engine.run() cannot start while another run is in progress");
    }
    this.runInProgress = true;
    try {
      return await this.runExclusive(task, options);
    } finally {
      try {
        this.permissionController.applyPending();
      } finally {
        this.runInProgress = false;
      }
    }
  }

  /**
   * Resolve the run's active behavior profile. A profile bound to the
   * persisted session kind wins (so e.g. a resumed pet session keeps the safe
   * profile even when the host omits behaviorMode); otherwise the explicit
   * behaviorMode names a registered profile directly. Explicit unknown modes
   * and non-work session kinds without an owning profile fail closed: silently
   * falling back to an unrestricted run would turn a missing extension into a
   * permission-boundary bypass.
   */
  private resolveBehaviorProfile(
    sessionKind: string,
    behaviorMode: string | undefined,
  ): RunBehaviorProfile | undefined {
    const explicitProfile =
      behaviorMode !== undefined ? this.behaviorProfiles.get(behaviorMode) : undefined;
    if (behaviorMode !== undefined && !explicitProfile) {
      throw new Error(`unknown behavior profile: ${behaviorMode}`);
    }

    const sessionProfile = [...this.behaviorProfiles.values()].find((profile) =>
      profile.activateForSessionKinds?.includes(sessionKind),
    );
    if (sessionKind !== "work" && !sessionProfile) {
      throw new Error(`session kind has no registered behavior profile: ${sessionKind}`);
    }
    return sessionProfile ?? explicitProfile;
  }

  private async runExclusive(task: string, options?: EngineRunOptions): Promise<EngineResult> {
    // Freeze permission context once, before the first await. Per-turn protocol
    // overrides live only for this run; persistent setPermissionMode/setPlanMode
    // calls made while busy are staged separately and cannot mutate this pair.
    const workspaceResolved = await resolveRunWorkspace({
      options,
      sessionManager: this.sessionManager,
      resolveBehaviorProfile: (kind, mode) => this.resolveBehaviorProfile(kind, mode),
      configPermissionMode: this.config.permissionMode,
      configCwd: this.config.cwd,
      settings: this.getSettingsManager(),
      processCwd: process.cwd(),
    });
    if (!workspaceResolved.ok) return workspaceResolved.result;
    const {
      sessionKind,
      sessionWorkspaceProfile,
      profile,
      profileParams,
      runPermissionMode,
      runPlanMode,
      cwd,
      profileState: {
        workspaceProfile: runWorkspaceProfile,
        sessionProfileOverrides,
        profileMemoryDir,
      },
    } = workspaceResolved.resolution;
    /** Structured results the profile's run services report; keyed per profile contract. */
    let profileReportedResults: Record<string, unknown> | undefined;

    // Wrap the caller's onStream so we can intercept `task_update`
    // events emitted by TodoWrite and keep an in-engine snapshot.
    // TaskGuard reads this snapshot at turn end to decide whether to
    // nag about stale in_progress items. Without the wrapper we'd
    // have no way to observe TodoWrite's emission — the canonical
    // store is the transcript, but TaskGuard runs in-loop and can't
    // afford a transcript scan per turn.
    let latestTodos: TaskInfo[] = [];
    const wrappedOnStream = this.buildWrappedOnStream({
      userOnStream: options?.onStream,
      getSession: () => session,
      setLatestTodos: (todos) => {
        latestTodos = todos;
      },
    });
    if (options) options.onStream = wrappedOnStream;

    const imageInput = await prepareRunImageInput({
      task,
      cwd,
      llm: this.config.llm,
      sessionId: options?.sessionId,
      attachments: options?.attachments,
    });
    if (!imageInput.ok) return imageInput.result;
    const { parsedTask, taskText } = imageInput;

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

    const toolCtx = await this.wireRunSandboxToolContext({
      options,
      cwd,
      runPermissionMode,
      runPlanMode,
      profile,
      profileParams,
      sessionProfileOverrides,
      profileMemoryDir,
      getSession: () => session,
      reportResult: (key, value) => {
        (profileReportedResults ??= {})[key] = value;
      },
    });

    logger.info("engine.run", {
      task: taskText.slice(0, 200),
      cwd,
      model: this.config.llm.model,
      preset: this.preset.name,
      imageCount: parsedTask.images.length,
    });

    const userMessageContent = buildRunUserMessageContent(parsedTask, cwd, taskText);

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
    // wrappedOnStream (defined before the session opens, executed only after)
    // closes over `session`, so keep the declaration here and assign from the
    // opener's result.
    let session!: SessionBundle;
    const openedResult = openRunSession({
      sessionManager: this.sessionManager,
      options,
      parsedTask,
      taskText,
      userMessageContent,
      cwd,
      sessionKind,
      sessionWorkspaceProfile,
      llmModel: this.config.llm.model,
      llmProvider: this.config.llm.provider,
      isSubAgent: this.config.isSubAgent === true,
      origin: this.config.origin,
      costStore: this.config.costStore,
      onAgentDirectionsDelivered: (ids) => this.agentDirectionsDeliveredListener?.(ids),
      cachedCompactedMessages: options?.sessionId
        ? this.compactedMessagesBySession.get(options.sessionId)
        : undefined,
    });
    if (!openedResult.ok) return openedResult.result;
    const { messages, freshImageMessage, resumedFromDisk, claimClientMessageId, releaseClientMessageId } =
      openedResult.opened;
    session = openedResult.opened.session;

    this.stampRunToolContext(toolCtx, session, options);
    const sessionRun = runWithSid(session.state.sessionId, async () => {
      const hookMessages = await this.runSessionStartHooks({
        session,
        task,
        cwd,
        runPermissionMode,
        resumedFromDisk,
        options,
        taskText,
        messages,
      });

      const sid = session.state.sessionId;
      const { contextManager, llmClientPromise, toolExecutor } =
        this.wireRunContextAndPermission({
          session,
          sid,
          options,
          cwd,
          toolCtx,
          runPermissionMode,
          messages,
          getLatestTodos: () => latestTodos,
          setLatestTodos: (todos) => {
            latestTodos = todos;
          },
        });

      const { promptComposer, toolDefs } = await this.wireRunTooling({
        options,
        session,
        cwd,
        toolCtx,
        profile,
        profileParams,
        runWorkspaceProfile,
        profileMemoryDir,
        sessionProfileOverrides,
        runPlanMode,
      });

      const { llmClient, fullSystemPrompt, dynamicContextMsg, userContextMsg } =
        await this.assembleRunPrompts({
          session,
          messages,
          hookMessages,
          promptComposer,
          toolDefs,
          llmClientPromise,
          contextManager,
          profile,
          profileParams,
        });

      // 1. Context-compaction summary (setSummarizeFn) → PRIMARY model. This
      //    condenses many rounds into the running summary that REPLACES the real
      //    history; a dropped decision makes the conversation "forget" and poisons
      //    every subsequent turn. It fires only near the compact ratio (~0.85), so
      //    it's infrequent — quality far outweighs the occasional extra cost of a
      //    primary-model call. (Manual /compact uses the primary for the same
      //    reason; see forceCompact.)
      //
      // 2. Tool-use one-liner summaries (modelFacade.summarize below) → AUX model.
      //    These are tiny throwaway outputs ("Wrote design doc") fired every turn;
      //    that high-frequency, low-stakes chore is exactly what aux is for.
      const auxSummaryClient = await this.resolveAuxClient(llmClient);
      // Auto-compaction runs inside TurnLoop.manageAsync(), after the loop has
      // initialized its run-scoped Goal tracker. The closure is wired before
      // construction but cannot execute until turnLoop.run() starts.
      // Assigned after the callbacks that close over it are constructed; they
      // cannot run until turnLoop.run(), so definite assignment is intentional.
      const {
        turnLoop,
        applyGoalTermination,
        goalHookHandler,
        fileHistoryHook,
        getRunUsage,
        recordExternalBilledUsage,
        accounting,
        usageBaseline,
      } = await this.wireRunLoop({
        session,
        sid,
        task,
        cwd,
        options,
        toolCtx,
        toolExecutor,
        contextManager,
        llmClient,
        auxSummaryClient,
        fullSystemPrompt,
        toolDefs,
        claimClientMessageId,
        releaseClientMessageId,
        freshImageMessage,
        dynamicContextMsg,
      });

      let result: Awaited<ReturnType<typeof turnLoop.run>>;
      let firstGoalTermination: GoalTerminationReason | undefined;
      try {
        ({ result, firstGoalTermination } = await this.runTurnLoopWithHeadlessDrain({
          turnLoop,
          messages,
          applyGoalTermination,
          session,
          options,
        }));
      } finally {
        // Run-scoped: drop the GoalStopHook so a later goal-less send on this
        // long-lived engine doesn't keep blocking stops.
        if (goalHookHandler) this.hooks.unregister("on_stop", goalHookHandler);
        if (this.activeGoalHook === goalHookHandler) {
          this.activeGoalHook = null;
          this.activeGoalHookAttached = false;
          this.activeRuntimeGoal = null;
          this.activePersistedRunGoal = null;
        }
        if (this.activeTurnLoop === turnLoop) this.activeTurnLoop = null;
        if (this.activeRunSession === session) this.activeRunSession = null;
        // Run-scoped too: this handler is re-registered every run(), so it must be
        // dropped here or it stacks duplicates that re-snapshot on every tool.
        fileHistoryHook.dispose();
      }
      return await this.finalizeRun({
        session,
        result,
        firstGoalTermination,
        turnCount: turnLoop.currentTurn,
        getRunUsage,
        usageBaseline,
        userContextMsg,
        dynamicContextMsg,
        options,
        cwd,
        llmClient,
        auxSummaryClient,
        recordExternalBilledUsage,
        accounting,
        profile,
        getProfileReportedResults: () => profileReportedResults,
      });
    });
    return Promise.resolve(sessionRun).catch((err): EngineResult =>
      buildRunFailureResult({
        err,
        session,
        options,
        persistFinalRunState: (state) => this.persistFinalRunState(state),
      }),
    );
  }

  /**
   * Terminal success path: forward to {@link finalizeRunSuccess} with the
   * engine-bound persistence / memory / hook closures filled in. Extracted from
   * the {@link runExclusive} skeleton so the terminal-state assembly reads as a
   * single call; behavior is unchanged.
   */
  private finalizeRun(args: {
    session: SessionBundle;
    result: Awaited<ReturnType<TurnLoop["run"]>>;
    firstGoalTermination: GoalTerminationReason | undefined;
    turnCount: number;
    getRunUsage: () => ReturnType<import("./model-facade.js").ModelFacade["getUsage"]>;
    usageBaseline: TokenUsage;
    userContextMsg: Message | null;
    dynamicContextMsg: Message | null;
    options: EngineRunOptions | undefined;
    cwd: string;
    llmClient: Awaited<ReturnType<typeof createLLMClient>>;
    auxSummaryClient: Awaited<ReturnType<typeof createLLMClient>>;
    recordExternalBilledUsage: (usage: TokenUsage) => CumulativeUsageCounters;
    accounting: ReturnType<typeof createRunUsageAccounting>;
    profile: RunBehaviorProfile | undefined;
    getProfileReportedResults: () => Record<string, unknown> | undefined;
  }): Promise<EngineResult> {
    const {
      session,
      result,
      firstGoalTermination,
      turnCount,
      getRunUsage,
      usageBaseline,
      userContextMsg,
      dynamicContextMsg,
      options,
      cwd,
      llmClient,
      auxSummaryClient,
      recordExternalBilledUsage,
      accounting,
      profile,
      getProfileReportedResults,
    } = args;
    return finalizeRunSuccess({
      session,
      result,
      firstGoalTermination,
      turnCount,
      getRunUsage,
      usageBaseline,
      userContextMsg,
      dynamicContextMsg,
      setCompactedMessages: (s, msgs) => this.compactedMessagesBySession.set(s, msgs),
      setLastMessages: (msgs) => {
        this.lastMessages = msgs;
      },
      options,
      emitHook: (event, payload, signal) => this.emitHook(event, payload, signal),
      cwd,
      llmClient,
      auxSummaryClient,
      recordExternalBilledUsage,
      runMemoryPipeline: (transcript, sessionId, runCwd, client, record) =>
        this.runMemoryPipeline(transcript, sessionId, runCwd, client, record),
      updatePersistedSessionState: (s, patch) => this.updatePersistedSessionState(s, patch),
      persistFinalRunState: (state) => this.persistFinalRunState(state),
      markRunAccountingFinalized: () => accounting.markRunAccountingFinalized(),
      costStoreSerialize: this.config.costStore
        ? () => this.config.costStore!.serialize() as Record<string, unknown>
        : undefined,
      profile,
      getProfileReportedResults,
    });
  }

  /**
   * Build the stream callback that wraps the caller's `onStream`: it snapshots
   * TodoWrite `task_update` events for TaskGuard and persists `goal_progress`
   * events to the transcript before delegating. Extracted verbatim from the
   * {@link runExclusive} skeleton; the todo buffer and (not-yet-open) session
   * are reached through the `setLatestTodos` / `getSession` accessors.
   */
  private buildWrappedOnStream(args: {
    userOnStream: StreamCallback | undefined;
    getSession: () => SessionBundle;
    setLatestTodos: (todos: TaskInfo[]) => void;
  }): StreamCallback {
    const { userOnStream, getSession, setLatestTodos } = args;
    return (event) => {
      if (event.type === "task_update") {
        setLatestTodos(event.tasks);
      }
      // Persist goal progress so replay/history shows how many rounds the
      // goal ran. Display-only — toMessages() ignores this type, so it never
      // re-enters the LLM context.
      if (event.type === "goal_progress") {
        getSession().transcript.append("goal_progress", {
          ...(event.goalId ? { goalId: event.goalId } : {}),
          status: event.status,
          round: event.round,
          ...(event.gaps ? { gaps: event.gaps } : {}),
        });
      }
      userOnStream?.(event);
    };
  }

  /**
   * Run the turn loop once, apply its goal termination, and — for a top-level
   * headless run only — drain background sub-agents before resolving. Extracted
   * verbatim from the body of the {@link runExclusive} try block; the cleanup
   * `finally` stays in the skeleton so the run-scoped hook/loop teardown is
   * guaranteed regardless of how this method returns or throws.
   */
  private async runTurnLoopWithHeadlessDrain(args: {
    turnLoop: TurnLoop;
    messages: Message[];
    applyGoalTermination: ReturnType<typeof createGoalTerminationApplier>;
    session: SessionBundle;
    options: EngineRunOptions | undefined;
  }): Promise<{
    result: Awaited<ReturnType<TurnLoop["run"]>>;
    firstGoalTermination: GoalTerminationReason | undefined;
  }> {
    const { turnLoop, messages, applyGoalTermination, session, options } = args;

    let result = await turnLoop.run(messages);
    let firstGoalTermination: GoalTerminationReason | undefined = result.goalTermination;
    applyGoalTermination(result.goalTermination, result.goalTerminationRound);

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
      result = await drainHeadlessBackgroundAgents({
        sid,
        session,
        signal: options?.signal,
        initialResult: result,
        runTurnLoop: (msgs) => turnLoop.run(msgs),
        applyGoalTermination,
        waitForBackgroundAgentChange: (s, sig) => this.waitForBackgroundAgentChange(s, sig),
        waitForBackgroundAgentChangeOrTimeout: (s, ms) =>
          this.waitForBackgroundAgentChangeOrTimeout(s, ms),
        getFirstGoalTermination: () => firstGoalTermination,
        setFirstGoalTermination: (t) => {
          firstGoalTermination = t;
        },
      });
    }

    return { result, firstGoalTermination };
  }

  /**
   * Stamp the resolved session identity and session-scoped side-effect sinks
   * onto the run's {@link ToolContext}, now that the session bundle is open.
   * Extracted verbatim from the {@link runExclusive} skeleton.
   */
  private stampRunToolContext(
    toolCtx: ToolContext,
    session: SessionBundle,
    options: EngineRunOptions | undefined,
  ): void {
    // B2 / Gate 1: stamp the resolved sid onto the tool context so
    // session-scoped side effects (background-agent completion
    // notifications) attribute to the right session. toolCtx is created
    // before the session bundle is resolved (see ~line 635), so this is
    // the first point we can set it. After this assignment treat the
    // field follows the latest successfully injected user intent for the rest
    // of the run, so tools launched after a steer attribute their side effects
    // to that steer rather than this original submit.
    toolCtx.sessionId = session.state.sessionId;
    toolCtx.originClientMessageId = options?.clientMessageId;
    toolCtx.recordExternalFileChanges = (record) => {
      session.transcript.append("external_file_changes", { ...record });
    };
    toolCtx.setSessionWorkspace = (workspace, persistedRevision) => {
      // Enter/ExitWorktree passes the revision returned by its in-process
      // field update. The desktop bridge persists in another process before
      // returning, so repeat the idempotent workspace update here to obtain a
      // revision owned by this live bundle.
      const stateRevision =
        persistedRevision ??
        this.sessionManager.setSessionWorkspace(session.state.sessionId, workspace);
      Object.assign(session.state, { workspace, stateRevision });
    };
  }

  /**
   * Await the parallel prompt/context assembly (LLM client handshake, system
   * prompt, dynamic + user context messages), splice the hook-injected and
   * context messages into `messages`, publish this run's last-session snapshot,
   * and prime the {@link ContextManager}'s transcript path + replacement state.
   * Extracted verbatim from the {@link runExclusive} skeleton.
   */
  private async assembleRunPrompts(args: {
    session: SessionBundle;
    messages: Message[];
    hookMessages: string[];
    promptComposer: PromptComposer;
    toolDefs: import("../types.js").ToolDefinition[];
    llmClientPromise: ReturnType<typeof createLLMClient>;
    contextManager: ContextManager;
    profile: RunBehaviorProfile | undefined;
    profileParams: Readonly<Record<string, unknown>>;
  }): Promise<{
    llmClient: Awaited<ReturnType<typeof createLLMClient>>;
    fullSystemPrompt: string;
    dynamicContextMsg: Message | null;
    userContextMsg: Message | null;
  }> {
    const {
      session,
      messages,
      hookMessages,
      promptComposer,
      toolDefs,
      llmClientPromise,
      contextManager,
      profile,
      profileParams,
    } = args;

    const [llmClient, baseSystemPrompt, dynamicContextMsg] = await Promise.all([
      llmClientPromise,
      // System prompt is now the STABLE prefix only — skills + git status moved
      // out to a trailing per-turn message so they no longer bust the cache.
      promptComposer.buildSystemPrompt(toolDefs),
      promptComposer.buildDynamicContextMessage(),
    ]);
    const fullSystemPrompt = composeRunSystemPrompt({
      baseSystemPrompt,
      profile,
      profileParams,
    });
    const userContextMsg = promptComposer.buildUserContextMessage();
    assembleRunMessages({
      messages,
      userContextMsg,
      hookMessages,
      dynamicContextMsg,
    });
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
    // Two summarizers with DIFFERENT quality needs (see the run loop wiring for
    // the aux-model summarizer set up alongside the ModelFacade).

    return { llmClient, fullSystemPrompt, dynamicContextMsg, userContextMsg };
  }

  /**
   * Seed the run's {@link ContextManager}, emit the early `session_started`
   * event, replay the last TodoWrite snapshot on resume, kick off the LLM client
   * handshake, and build the permission-gated {@link ToolExecutor}. Extracted
   * verbatim from the {@link runExclusive} skeleton; the todo snapshot is read
   * and written through the `getLatestTodos` / `setLatestTodos` accessors so the
   * outer wrapped-onStream and TaskGuard keep observing the same buffer.
   */
  private wireRunContextAndPermission(args: {
    session: SessionBundle;
    sid: string;
    options: EngineRunOptions | undefined;
    cwd: string;
    toolCtx: ToolContext;
    runPermissionMode: NonNullable<EngineConfig["permissionMode"]>;
    messages: Message[];
    getLatestTodos: () => TaskInfo[];
    setLatestTodos: (todos: TaskInfo[]) => void;
  }): {
    contextManager: ContextManager;
    llmClientPromise: ReturnType<typeof createLLMClient>;
    toolExecutor: import("../tool-system/executor.js").ToolExecutor;
  } {
    const {
      session,
      sid,
      options,
      cwd,
      toolCtx,
      runPermissionMode,
      messages,
      getLatestTodos,
      setLatestTodos,
    } = args;

    const { contextManager, ctxSeed } = createRunContextManager({
      maxTokens: this.resolveMaxContextTokens(),
      ratios: this.resolveContextRatios(),
      persistedAnchor: session.state.contextUsageAnchor,
      llmProvider: this.config.llm.provider,
      llmModel: this.config.llm.model,
      messages,
      needsCtxSeed: !this.ctxSeedSent.has(sid),
    });
    this.lastContextManager = contextManager;
    if (!this.ctxSeedSent.has(sid)) this.ctxSeedSent.add(sid);

    // Tell the client the sid *now* instead of waiting for run() to resolve.
    // The user wants `/sid` to work mid-turn; without this, the client only
    // learns the sid when the run completes.
    options?.onStream?.({
      type: "session_started",
      sessionId: sid,
      promptTokens: ctxSeed.tokens,
      promptTokensSource: ctxSeed.source,
      promptTokensConfidence: ctxSeed.confidence,
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
        setLatestTodos(snap);
        options?.onStream?.({ type: "task_update", tasks: snap });
      }
    }

    // Kick off LLM client creation early (network handshake)
    const llmClientPromise = createLLMClient(this.config.llm, this.config.clientDefaults);
    // MCP connection below may keep us from awaiting this promise for a while.
    // Observe rejection immediately so a fast client-init failure cannot become
    // an unhandledRejection during that gap; Promise.all still receives the
    // original promise and routes the same error through the lifecycle catch.
    void llmClientPromise.catch(() => {});

    const mode = runPermissionMode;
    const { toolExecutor } = buildRunPermissionPipeline({
      permissionController: this.permissionController,
      mode,
      cwd,
      approvalRouter: toolCtx.approvalRouter,
      sessionId: session.state.sessionId,
      toolRegistry: this.toolRegistry,
      hooks: this.hooks,
      toolCtx,
      signal: options?.signal,
      readOnlySession: this.config.readOnlySession === true,
      headless: this.config.headless === true,
      getLatestTodos: () => getLatestTodos(),
      onApprovalPhase: (waiting, toolName) => {
        options?.onAgentProgress?.({
          type: "phase",
          phase: waiting ? "waiting-permission" : "tool",
          toolName,
        });
      },
      emitNotificationHook: (payload) => {
        void this.emitHook("notification", payload);
      },
    });

    return { contextManager, llmClientPromise, toolExecutor };
  }

  /**
   * Resolve the run sandbox, construct the child sub-agent spawner (the sole
   * `new Engine(...)` call path, kept in engine.ts so the protocol bypass guard
   * stays satisfied), and assemble the per-run {@link ToolContext}. Extracted
   * verbatim from the {@link runExclusive} skeleton; the session bundle is read
   * lazily via `getSession` because it is opened after this wiring runs.
   */
  private async wireRunSandboxToolContext(args: {
    options: EngineRunOptions | undefined;
    cwd: string;
    runPermissionMode: NonNullable<EngineConfig["permissionMode"]>;
    runPlanMode: boolean;
    profile: RunBehaviorProfile | undefined;
    profileParams: Readonly<Record<string, unknown>>;
    sessionProfileOverrides: import("./run-setup.js").RunProfileState["sessionProfileOverrides"];
    profileMemoryDir: string | undefined;
    getSession: () => SessionBundle;
    reportResult: (key: string, value: unknown) => void;
  }): Promise<ToolContext> {
    const {
      options,
      cwd,
      runPermissionMode,
      runPlanMode,
      profile,
      profileParams,
      sessionProfileOverrides,
      profileMemoryDir,
      getSession,
      reportResult,
    } = args;

    // Resolve before constructing the child spawner: a parent sandbox may come
    // solely from project/user settings rather than config.sandbox, while a
    // child intentionally skips project settings. Passing the complete
    // effective config is what makes undefined role sandbox mean inherit.
    const sandboxConfig = this.runEnvironmentResolver.resolveSandboxConfig(cwd);

    // Build the per-Engine ToolContext that will be threaded through every
    // tool call. Replaces the old module-level singleton setters used by
    // built-ins and product capabilities.
    const subAgentSpawner = createSubAgentSpawner({
      parentConfig: this.config,
      parentSandbox: sandboxConfig,
      presetName: this.preset.name,
      cwd,
      permissionMode: runPermissionMode,
      modelPool: this.modelPool,
      parentStream: options?.onStream,
      appendParentSubagent: (agentId, description) => {
        getSession().transcript.appendSubagent(agentId, undefined, description);
      },
      sessionExists: (sessionId) => this.sessionManager.exists(sessionId),
      getSessionParentId: (sessionId) => this.sessionManager.readParentSessionId(sessionId),
      childRunner: {
        createChild: (config) => new Engine(config),
        runChild: async (config, childTask, childOptions) => {
          const child = new Engine(config);
          return child.run(childTask, childOptions);
        },
      },
    });

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
    const sandboxBackend = await this.runEnvironmentResolver.resolveSandbox(cwd);

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

    const toolCtx: ToolContext = buildRunToolContext({
      base: this.buildToolContext(cwd, sessionProfileOverrides, profileMemoryDir),
      options,
      configApprovalRouter: this.config.approvalRouter,
      runPermissionMode,
      runPlanMode,
      subAgentSpawner,
      agentDefinitions: this.getAgentDefinitions(cwd, sessionProfileOverrides),
      sandbox:
        sandboxBackend.name === "off"
          ? sandboxBackend
          : { ...sandboxBackend, network: sandboxConfig.network },
      cwd,
      shellEnv: this.runEnvironmentResolver.readShellEnv(cwd),
      profile,
      profileParams,
      reportResult,
    });

    return toolCtx;
  }

  /**
   * Wire every run-scoped dependency the turn loop needs: usage accounting +
   * summarizer, the {@link ModelFacade}, the file-history hook, the
   * `on_agent_start` hook, goal resolution / arming, the {@link TurnLoop} itself,
   * and the goal-termination applier. Extracted verbatim from the
   * {@link runExclusive} skeleton; the goal slots, judge-context buffer and usage
   * baseline are fully local here — only the values the try/finally + finalize
   * phases consume cross back out.
   */
  private async wireRunLoop(args: {
    session: SessionBundle;
    sid: string;
    task: string;
    cwd: string;
    options: EngineRunOptions | undefined;
    toolCtx: ToolContext;
    toolExecutor: import("../tool-system/executor.js").ToolExecutor;
    contextManager: ContextManager;
    llmClient: Awaited<ReturnType<typeof createLLMClient>>;
    auxSummaryClient: Awaited<ReturnType<typeof createLLMClient>>;
    fullSystemPrompt: string;
    toolDefs: import("../types.js").ToolDefinition[];
    claimClientMessageId: (
      bundle: SessionBundle,
      clientMessageId: string | undefined,
      source: "submit" | "steer",
    ) => boolean;
    releaseClientMessageId: (clientMessageId: string) => void;
    freshImageMessage: Message | undefined;
    dynamicContextMsg: Message | null;
  }): Promise<{
    turnLoop: TurnLoop;
    applyGoalTermination: ReturnType<typeof createGoalTerminationApplier>;
    goalHookHandler: import("./run-goal.js").GoalStopHookHandler | null;
    fileHistoryHook: ReturnType<typeof registerFileHistoryHook>;
    getRunUsage: () => ReturnType<import("./model-facade.js").ModelFacade["getUsage"]>;
    recordExternalBilledUsage: (usage: TokenUsage) => CumulativeUsageCounters;
    accounting: ReturnType<typeof createRunUsageAccounting>;
    usageBaseline: TokenUsage;
  }> {
    const {
      session,
      sid,
      task,
      cwd,
      options,
      toolCtx,
      toolExecutor,
      contextManager,
      llmClient,
      auxSummaryClient,
      fullSystemPrompt,
      toolDefs,
      claimClientMessageId,
      releaseClientMessageId,
      freshImageMessage,
      dynamicContextMsg,
    } = args;

    // eslint-disable-next-line prefer-const
    let turnLoop!: TurnLoop;
    const accounting = createRunUsageAccounting({
      session,
      sid,
      resumeState: (s) => this.sessionManager.resume(s).state,
      updatePersistedSessionState: (s, patch) => this.updatePersistedSessionState(s, patch),
      costStore: this.config.costStore,
      recordGoalJudgeUsage: (usage) => turnLoop.recordGoalJudgeUsage(usage),
    });
    const { recordCumulativeUsage, recordExternalBilledUsage } = accounting;
    contextManager.setSummarizeFn(this.buildSummarizeFn(llmClient, recordExternalBilledUsage));
    const { modelFacade, getRunUsage } = wireRunModelFacade({
      llmClient,
      auxSummaryClient,
      transcript: session.transcript,
      accounting,
    });

    // Session-cumulative usage baseline: the LLM client is recreated per run
    // (its getUsage() counts only THIS run), so to accumulate across runs we
    // capture the persisted total at run start and fold this run's usage onto
    // it (see foldRunUsage). Snapshot now, before any turn boundary fires.
    const usageBaseline: TokenUsage = { ...session.state.tokenUsage };

    const sessionDir = join(
      this.config.sessionStorageDir ?? sessionsRoot(),
      session.state.sessionId,
    );
    const fileHistoryHook = registerFileHistoryHook({
      hooks: this.hooks,
      sessionDir,
      cwd,
      getTurnSeq: () => session.state.turnSeq,
      contributions: this.capabilities.flatMap((capability) => [
        ...(capability.fileHistory ?? []),
      ]),
    });

    // Hook: agent start
    await this.emitHook(
      "on_agent_start",
      {
        sessionId: session.state.sessionId,
        task,
        model: this.config.llm.model,
      },
      options?.signal,
    );

    // Goal mode: register a GoalStopHook for the lifetime of THIS run so the
    // turn loop keeps going until the session model judges the goal met.
    // Registered per-run (and cleared in `finally`) so a later goal-less
    // send doesn't inherit a stale goal. The judge runs on the primary
    // session client; auxSummaryClient remains dedicated to low-consequence
    // summaries/titles and retains defaults.auxText routing/fallback behavior.
    // Normalize the raw goal (string | GoalConfig) once at the run boundary;
    // everything inward uses the GoalConfig. normalizeGoal() returns undefined
    // when there's effectively no goal (empty objective).
    //
    // PERSISTENT GOAL (CC /goal style): a goal set on one send survives across
    // later sends and manual interrupts until met or cleared. Goal completion
    // is a high-consequence decision, so V1 routes it to the primary session
    // client, which is the model expected to interpret the supplied execution
    // evidence. defaults.auxText remains in force for summaries, titles and
    // other auxiliary work through auxSummaryClient.
    // Resolution:
    //   1. options.goal — this send explicitly sets/replaces the goal.
    //   2. session.state.goalLifecycle — a goal set on an earlier send.
    //   3. config.goal — engine-level default (rare; e.g. headless).
    // When (1) supplies a goal that differs from the stored one we REPLACE the
    // persisted active goal (one active goal per session) and announce it. A
    // bare send with no options.goal inherits the stored active goal so the
    // model keeps working toward it — that's what makes it persistent.
    const goalSlots: GoalRunSlots = {
      getActiveRuntimeGoal: () => this.activeRuntimeGoal,
      setActiveRuntimeGoal: (g) => {
        this.activeRuntimeGoal = g;
      },
      getActivePersistedRunGoal: () => this.activePersistedRunGoal,
      setActivePersistedRunGoal: (g) => {
        this.activePersistedRunGoal = g;
      },
      getActiveGoalHook: () => this.activeGoalHook,
      setActiveGoalHook: (h) => {
        this.activeGoalHook = h;
      },
      setActiveGoalHookAttached: (a) => {
        this.activeGoalHookAttached = a;
      },
    };
    const { normalizedGoal, persistedRunGoal } = resolveRunGoal({
      options,
      session,
      sessionManager: this.sessionManager,
      configGoal: this.config.goal,
      isSubAgent: this.config.isSubAgent === true,
      sid,
      onStream: options?.onStream,
    });
    let latestGoalJudgeContext: GoalJudgeRuntimeContext | undefined;
    const goalHookHandler = armRunGoalHook({
      slots: goalSlots,
      hooks: this.hooks,
      llmClient,
      isSubAgent: this.config.isSubAgent === true,
      normalizedGoal,
      persistedRunGoal,
      session,
      sessionManager: this.sessionManager,
      persistGoalTerminal: (state, goal, reason) => this.persistGoalTerminal(state, goal, reason),
      getJudgeContext: () => latestGoalJudgeContext,
      recordCumulativeUsage,
      recordGoalJudgeUsage: (usage) => turnLoop.recordGoalJudgeUsage(usage),
    });

    turnLoop = this.buildTurnLoop({
      modelFacade,
      toolExecutor,
      contextManager,
      session,
      fullSystemPrompt,
      toolDefs,
      sid,
      options,
      cwd,
      claimClientMessageId,
      releaseClientMessageId,
      toolCtx,
      persistedRunGoal,
      goalHookHandler,
      normalizedGoal,
      freshImageMessage,
      dynamicContextMsg,
      usageBaseline,
      getRunUsage,
      recordCumulativeUsage,
      publishGoalJudgeContext: (context) => {
        latestGoalJudgeContext = context;
      },
    });
    toolCtx.recordBilledUsage = recordExternalBilledUsage;

    // Expose this run's loop for mid-run extension (TODO 3.1). Top-level only —
    // a sub-agent's loop is its own concern and isn't user-extendable.
    if (this.config.isSubAgent !== true) this.activeTurnLoop = turnLoop;
    // Expose this run's session bundle so a mid-run clearGoal() wipes the goal
    // on the very instance this loop keeps saving (see field doc). Top-level
    // only — sub-agents don't carry user-clearable persistent goals.
    if (this.config.isSubAgent !== true) this.activeRunSession = session;

    const applyGoalTermination = createGoalTerminationApplier({
      slots: goalSlots,
      hooks: this.hooks,
      session,
      persistedRunGoal,
      goalHookHandler,
      persistGoalTerminalOutcome: (state, goal, t) =>
        this.persistGoalTerminalOutcome(state, goal, t),
      readActiveGoal: (s) => this.sessionManager.readActiveGoal(s),
      onStream: options?.onStream,
    });

    return {
      turnLoop,
      applyGoalTermination,
      goalHookHandler,
      fileHistoryHook,
      getRunUsage,
      recordExternalBilledUsage,
      accounting,
      usageBaseline,
    };
  }

  /**
   * Record the session start and fire the once-per-run `on_session_start` and
   * per-turn `user_prompt_submit` / `agent_direction_submit` hooks, applying any
   * `updatedPrompt` rewrite in place on `messages`. Extracted verbatim from the
   * {@link runExclusive} skeleton; returns the combined hook-injected messages
   * for {@link assembleRunMessages}.
   */
  private async runSessionStartHooks(args: {
    session: SessionBundle;
    task: string;
    cwd: string;
    runPermissionMode: NonNullable<EngineConfig["permissionMode"]>;
    resumedFromDisk: boolean;
    options: EngineRunOptions | undefined;
    taskText: string;
    messages: Message[];
  }): Promise<string[]> {
    const { session, task, cwd, runPermissionMode, resumedFromDisk, options, taskText, messages } =
      args;

    recordSessionStart(session.state.sessionId, {
      // Strip <codeshell-image> base64 payloads before they reach
      // <repo>/log/. Reader still sees the marker + byte count, just
      // not the bytes. Transcript persistence keeps the full payload.
      task: sanitizeTaskString(task),
      cwd,
      model: this.config.llm.model,
      provider: this.config.llm.provider,
      permissionMode: runPermissionMode,
      resumed: resumedFromDisk,
    });

    // Session-level hook: fired once per Engine.run() entry, regardless of
    // cold-start vs resume. Handlers can return `messages` to inject a
    // <system-reminder> at the head of the conversation (between
    // userContext and the new user prompt). Used by the built-in
    // superpowers injector to surface the `using-superpowers` ruleset.
    const sessionStartHook = await this.emitHook(
      "on_session_start",
      {
        sessionId: session.state.sessionId,
        cwd,
        resumed: resumedFromDisk,
        source: resumedFromDisk ? "resume" : "startup",
      },
      options?.signal,
    );

    // Per-turn hook: fired every time a new user prompt enters the loop.
    // Equivalent to CC's UserPromptSubmit. Handlers can inject lightweight
    // reminders that should accompany each user turn (e.g. "skills
    // available — check before acting").
    const promptSubmitHook = await this.emitHook(
      options?.agentDirection ? "agent_direction_submit" : "user_prompt_submit",
      {
        sessionId: session.state.sessionId,
        // Pass the text-only portion. Handlers reading the prompt for keyword
        // detection / classification (e.g. superpowers' "did the user ask
        // about X?") don't gain anything from megabytes of base64 inlined here,
        // and silently leaking attachment bytes through hooks is the kind of
        // exfiltration risk a curious user-installed shell hook shouldn't carry.
        prompt: taskText,
        resumed: resumedFromDisk,
        ...(options?.agentDirection
          ? {
              source: "agent-direction",
              authority: "agent",
              envelopeIds: options.agentDirection.envelopeIds,
              correlationIds: options.agentDirection.correlationIds,
            }
          : {}),
      },
      options?.signal,
    );
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

    return [...(sessionStartHook.messages ?? []), ...(promptSubmitHook.messages ?? [])];
  }

  /**
   * Resolve goal visibility, disabled skill/plugin lists, build the
   * {@link PromptComposer}, connect MCP, and assemble the visibility-filtered
   * tool defs for this run. Extracted verbatim from the {@link runExclusive}
   * skeleton; the intermediate visibility/disabled/mcp values are fully local to
   * this method — only the composer and tool defs cross back out.
   */
  private async wireRunTooling(args: {
    options: EngineRunOptions | undefined;
    session: SessionBundle;
    cwd: string;
    toolCtx: ToolContext;
    profile: RunBehaviorProfile | undefined;
    profileParams: Readonly<Record<string, unknown>>;
    runWorkspaceProfile: import("./run-setup.js").RunProfileState["workspaceProfile"];
    profileMemoryDir: string | undefined;
    sessionProfileOverrides: import("./run-setup.js").RunProfileState["sessionProfileOverrides"];
    runPlanMode: boolean;
  }): Promise<{ promptComposer: PromptComposer; toolDefs: import("../types.js").ToolDefinition[] }> {
    const {
      options,
      session,
      cwd,
      toolCtx,
      profile,
      profileParams,
      runWorkspaceProfile,
      profileMemoryDir,
      sessionProfileOverrides,
      runPlanMode,
    } = args;

    const visibilityExplicitGoal = normalizeGoal(options?.goal);
    const visibilityLifecycle = session.state.goalLifecycle;
    const visibilityStoredGoal =
      visibilityLifecycle && isGoalLifecycleCurrent(visibilityLifecycle)
        ? goalConfigFromLifecycle(visibilityLifecycle)
        : undefined;
    const visibilityDefaultGoal = normalizeGoal(this.config.goal);
    const hasRunnableGoal =
      this.config.isSubAgent !== true &&
      ((visibilityExplicitGoal !== undefined && visibilityExplicitGoal.paused !== true) ||
        (visibilityStoredGoal !== undefined && visibilityStoredGoal.paused !== true) ||
        (visibilityDefaultGoal !== undefined && visibilityDefaultGoal.paused !== true));

    const { disabledSkills, disabledPlugins } = this.readDisabledLists(
      cwd,
      sessionProfileOverrides,
    );
    const promptComposer = new PromptComposer(
      buildPromptComposerConfig({
        cwd,
        model: this.config.llm.model,
        preset: this.preset,
        customSystemPrompt: this.config.customSystemPrompt,
        appendSystemPrompt:
          [this.config.appendSystemPrompt, profile?.systemPromptAppend]
            .filter(Boolean)
            .join("\n\n") || undefined,
        responseLanguage: this.config.responseLanguage,
        userProfile: this.config.userProfile,
        workspaceProfile: runWorkspaceProfile,
        profileMemoryDir,
        instructionCompatFileNames: compatFileNamesFrom(this.config.instructions),
        instructionBoundaryFinder: (scanCwd) =>
          resolveInstructionBoundary(scanCwd, this.capabilities),
        disabledSkills,
        disabledPlugins,
        skillAllowlist: this.config.skillAllowlist,
        memoriesMaxAgeDays: this.readMemoriesConfig()?.maxAge,
        goalToolState: { hasGoal: hasRunnableGoal },
        capabilityPromptSections: this.capabilityPromptSections,
        dynamicContextProviders: this.capabilityDynamicContextProviders,
        getSettingsManager: () => this.getSettingsManager(),
        toolCatalog: this.toolCatalog,
      }),
    );

    const mcpServers = this.config.mcpServers ?? {};
    const mcpDisabled = profile?.disableMcp === true;
    await connectRunMcp({
      mcpServers,
      mcpDisabled,
      getManager: () => this.mcpManager,
      setManager: (m) => {
        this.mcpManager = m;
      },
      runtimePool: this.runtime?.mcpPool,
      toolRegistry: this.toolRegistry,
      engineForConnect: this,
      emitNotificationHook: (payload) => {
        void this.emitHook("notification", payload);
      },
    });

    // Parallelize slow initialization:
    //   1. createLLMClient — network handshake (started earlier)
    //   2. buildSystemPrompt — cacheable prompt assembled from generic sections
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
    const toolDefs = assembleRunToolDefs({
      toolRegistry: this.toolRegistry,
      toolCtx,
      guardCwd: toolCtx.cwd,
      hasRunnableGoal,
      settingsScope: this.config.settingsScope ?? "project",
      builtinToolHost: this.config.builtinToolHost,
      isSubAgent: this.config.isSubAgent === true,
      behaviorProfileId: profile?.id ?? options?.behaviorMode,
      profileMeta: profile?.buildVisibilityMeta?.(profileParams),
      builtinOverride: this.readBuiltinOverride(toolCtx.cwd, sessionProfileOverrides),
      mcpServers: this.config.mcpServers ?? {},
      mcpDisabled,
      featureFlags: this.readFeatureFlags(),
      toolGuards: this.toolGuards,
      toolRewriters: this.toolRewriters,
      toolFeatureFlags: TOOL_FEATURE_FLAGS,
      applyBuiltinOverrideVisibility,
      profileAllowedToolNames: profile?.allowedToolNames,
      runPlanMode,
    });

    return { promptComposer, toolDefs };
  }

  /**
   * Assemble the run-scoped {@link TurnLoop} (its dependency object + option
   * object) from the per-run locals gathered in {@link runExclusive}. Extracted
   * verbatim from the orchestration skeleton so `runExclusive` stays a readable
   * sequence of phase calls; the buffered-compaction `let` lives entirely inside
   * here now, and the only value crossing back out is the goal-judge context,
   * published through the `publishGoalJudgeContext` callback.
   */
  private buildTurnLoop(args: {
    modelFacade: import("./model-facade.js").ModelFacade;
    toolExecutor: import("../tool-system/executor.js").ToolExecutor;
    contextManager: ContextManager;
    session: SessionBundle;
    fullSystemPrompt: string;
    toolDefs: import("../types.js").ToolDefinition[];
    sid: string;
    options: EngineRunOptions | undefined;
    cwd: string;
    claimClientMessageId: (
      bundle: SessionBundle,
      clientMessageId: string | undefined,
      source: "submit" | "steer",
    ) => boolean;
    releaseClientMessageId: (clientMessageId: string) => void;
    toolCtx: ToolContext;
    persistedRunGoal: GoalConfig | undefined;
    goalHookHandler: import("./run-goal.js").GoalStopHookHandler | null;
    normalizedGoal: GoalConfig | undefined;
    freshImageMessage: Message | undefined;
    dynamicContextMsg: Message | null;
    usageBaseline: TokenUsage;
    getRunUsage: () => ReturnType<import("./model-facade.js").ModelFacade["getUsage"]>;
    recordCumulativeUsage: (usage: TokenUsage) => CumulativeUsageCounters;
    publishGoalJudgeContext: (context: GoalJudgeRuntimeContext) => void;
  }): TurnLoop {
    const {
      modelFacade,
      toolExecutor,
      contextManager,
      session,
      fullSystemPrompt,
      toolDefs,
      sid,
      options,
      cwd,
      claimClientMessageId,
      releaseClientMessageId,
      toolCtx,
      persistedRunGoal,
      goalHookHandler,
      normalizedGoal,
      freshImageMessage,
      dynamicContextMsg,
      usageBaseline,
      getRunUsage,
      recordCumulativeUsage,
      publishGoalJudgeContext,
    } = args;

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
        consumeSteer: (source) => this.consumeSteer(sid, source),
        consumeAgentDirections:
          this.config.isSubAgent === true
            ? () =>
                notificationQueue.drain(
                  sid,
                  (envelope) =>
                    envelope.kind === "direction" &&
                    envelope.runtimeGeneration === options?.runtimeGeneration,
                ) as import("../tool-system/builtin/agent-notifications.js").DirectionEnvelope[]
            : undefined,
        onAgentControlState:
          this.config.isSubAgent === true
            ? (state) => {
                this.agentControlStateListener?.(state);
                if (state === "model") {
                  options?.onAgentProgress?.({ type: "phase", phase: "model" });
                } else if (state === "tool-batch") {
                  options?.onAgentProgress?.({ type: "phase", phase: "tool" });
                }
              }
            : undefined,
        onAgentDirectionsDelivered:
          this.config.isSubAgent === true
            ? (envelopeIds) => this.agentDirectionsDeliveredListener?.(envelopeIds)
            : undefined,
        restoreSteer: (items) => this.restoreSteer(sid, items),
        buildSteerUserMessageContent: async (item) => {
          const steerImageInput = await prepareRunImageInput({
            task: item.text,
            cwd,
            llm: this.config.llm,
            sessionId: sid,
            attachments: item.attachments,
          });
          if (!steerImageInput.ok) {
            throw new Error(steerImageInput.result.text);
          }
          return buildRunUserMessageContent(
            steerImageInput.parsedTask,
            cwd,
            steerImageInput.taskText,
          );
        },
        claimClientMessageId: (clientMessageId, source) =>
          claimClientMessageId(session, clientMessageId, source),
        releaseClientMessageId,
        setOriginClientMessageId: (clientMessageId) => {
          toolCtx.originClientMessageId = clientMessageId;
        },
        recordCumulativeUsage,
        onAgentUsage: (usage) => options?.onAgentProgress?.({ type: "usage", usage }),
        recordCacheReadDiagnostics: (sample) => {
          this.recordCacheReadDiagnostics(sid, sample);
        },
        recordContextUsageAnchor: (anchor) => {
          session.state.contextUsageAnchor = {
            ...anchor,
            provider: this.config.llm.provider,
            model: this.config.llm.model,
          };
        },
        // Clear the persisted goal for a self-reported completion / confirmed
        // cancel. Clears the in-RAM session's activeGoal (so THIS run's later
        // turns don't re-arm) AND persists it, and drops the in-flight stop
        // hook so nothing re-blocks the stop we're about to return.
        clearPersistedGoal: (reason) => {
          const runGoal = this.activePersistedRunGoal ?? persistedRunGoal;
          if (runGoal && !this.persistGoalTerminal(session.state, runGoal, reason)) {
            return false;
          }
          if (goalHookHandler) {
            this.hooks.unregister("on_stop", goalHookHandler);
            if (this.activeGoalHook === goalHookHandler) {
              this.activeGoalHook = null;
              this.activeGoalHookAttached = false;
              this.activeRuntimeGoal = null;
              this.activePersistedRunGoal = null;
            }
          }
          return true;
        },
        publishGoalJudgeContext: (context) => {
          publishGoalJudgeContext(context);
        },
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
        freshImageMessages: freshImageMessage ? [freshImageMessage] : undefined,
        volatileContextMessages: dynamicContextMsg ? [dynamicContextMsg] : undefined,
        // Goal mode: the active goal is surfaced to the on_stop handler via
        // ctx.data.goal; the GoalStopHook (registered above) judges it.
        goal: normalizedGoal,
        // Heartbeat: flush turnCount + tokens to state.json after every turn
        // so external observers (other CLI processes, /sid, the session list)
        // see live progress instead of a stale snapshot from the last
        // completed run.
        onTurnBoundary: (turnCount) => {
          session.state.turnCount = turnCount;
          // baseline + this run's running total (idempotent per boundary,
          // accumulates across runs; carries cacheRead/cacheCreation too).
          session.state.tokenUsage = foldRunUsage(usageBaseline, getRunUsage());
          // Surface the whole-session monotonic cache counts to the UI.
          // Separate from turn-loop's authoritative per-response emit (which
          // drives the live context reading and single-turn metric).
          const cumulative = normalizeCumulativeUsageCounters(
            session.state,
            session.state.tokenUsage,
          );
          const cumulativeHitRate = cumulativeCacheHitRate(cumulative);
          options?.onStream?.({
            type: "usage_update",
            promptTokens: cumulative.cumulativePromptTokens,
            promptTokensSource: "session_cumulative",
            promptTokensConfidence: "high",
            cumulativePromptTokens: cumulative.cumulativePromptTokens,
            cumulativeCacheReadTokens: cumulative.cumulativeCacheReadTokens,
            cumulativeCacheCreationTokens: cumulative.cumulativeCacheCreationTokens,
            ...(cumulativeHitRate !== undefined
              ? { cumulativeCacheHitRate: cumulativeHitRate }
              : {}),
            sessionPromptTokens: cumulative.cumulativePromptTokens,
            sessionCacheReadTokens: cumulative.cumulativeCacheReadTokens,
            sessionCacheCreationTokens: cumulative.cumulativeCacheCreationTokens,
          });
          if (this.config.costStore) {
            session.state.costState = this.config.costStore.serialize() as Record<
              string,
              unknown
            >;
          }
          this.persistRunProgress(session.state);
        },
      },
    );
    return turnLoop;
  }

  private buildSummarizeFn(
    auxSummaryClient: Awaited<ReturnType<typeof createLLMClient>>,
    recordCumulativeUsage?: (usage: TokenUsage) => CumulativeUsageCounters,
  ): (prompt: string, signal?: AbortSignal) => Promise<string> {
    return this.auxiliaryPipeline.buildSummarizeFn(auxSummaryClient, recordCumulativeUsage);
  }

  private async resolveAuxClient(
    fallback: Awaited<ReturnType<typeof createLLMClient>>,
  ): Promise<Awaited<ReturnType<typeof createLLMClient>>> {
    return this.auxiliaryPipeline.resolveAuxClient(fallback);
  }

  private async runMemoryPipeline(
    transcript: import("../session/transcript.js").Transcript,
    sessionId: string,
    cwd: string,
    primaryClient: Awaited<ReturnType<typeof createLLMClient>>,
    recordBilledUsage?: (usage: TokenUsage) => void,
  ): Promise<void> {
    return this.auxiliaryPipeline.runMemoryPipeline(
      transcript,
      sessionId,
      cwd,
      primaryClient,
      recordBilledUsage,
    );
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  /** Registry suitable for constructing EngineRuntime; excludes local capabilities. */
  getRuntimeToolRegistry(): ToolRegistry {
    return this.runtimeToolRegistry;
  }

  /**
   * Switch the active model by pool key. Takes effect on the next run() call.
   * Returns the new model entry.
   *
   * Persists settings.defaults.text (= the connection id / pool key) so the
   * next process startup defaults to the same model — without this, switches
   * only live in memory and every restart reverts to the previously persisted
   * defaults.text.
   */
  switchModel(key: string): ModelEntry {
    const entry = this.modelPool.switch(key);
    // LLMConfig is pure model identity now — rotate it wholesale. Cross-model
    // runtime knobs (temperature/timeout/retryMaxAttempts/imageDetail) live on
    // this.config.clientDefaults and survive the switch untouched.
    const nextLlm = this.modelPool.toLLMConfig(entry);
    this.config = { ...this.config, llm: nextLlm };
    this.persistActiveModel(entry);
    return entry;
  }

  /**
   * Zero the legacy/model-scoped token/cache usage window on disk. The
   * whole-session cumulative counters are intentionally left alone.
   */
  resetSessionUsage(sessionId: string): void {
    const zero: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    // If the session is mid-run right now, update its live state so the next
    // turn-boundary write doesn't re-fold a stale baseline.
    if (this.activeRunSession?.state.sessionId === sessionId) {
      this.activeRunSession.state.tokenUsage = { ...zero };
    }
    // Persist to disk so a reload / next run picks up the reset.
    if (this.sessionManager.exists(sessionId)) {
      try {
        if (this.activeRunSession?.state.sessionId === sessionId) {
          this.sessionManager.saveStateOrUpdateFields(this.activeRunSession.state, {
            tokenUsage: { ...zero },
          });
        } else {
          this.sessionManager.updateSessionState(sessionId, { tokenUsage: { ...zero } });
        }
      } catch {
        // Session not resumable (never persisted yet) — the in-memory reset
        // above covers the live case; nothing else to do.
      }
    }
  }

  /**
   * Write the active model selection to ~/.code-shell/settings.json.
   *
   * Persists settings.defaults.text = entry.key (the connection id == pool
   * key). That is the single field the boot path reads to restore the active
   * text model on the next startup (see ctor: settings.defaults.text → pool
   * switch). No legacy activeKey/model.* mirror is written.
   */
  private persistActiveModel(entry: ModelEntry): void {
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

      const prevDefaults =
        typeof existing.defaults === "object" && existing.defaults
          ? (existing.defaults as Record<string, unknown>)
          : {};
      const updated: Record<string, unknown> = {
        ...existing,
        defaults: { ...prevDefaults, text: entry.key },
      };

      // mode 0o600: this writes model.apiKey (plaintext) into settings.json, so
      // it must be owner-only — same R-1 hardening as SettingsManager/onboarding.
      // (Third settings.json writer; the R-1 sweep initially missed this one.)
      const tmp = `${file}.${process.pid}.tmp`;
      const payload = JSON.stringify(updated, null, 2) + "\n";
      writeFileSync(tmp, payload, { encoding: "utf-8", mode: 0o600 });
      try {
        renameSync(tmp, file);
      } catch {
        writeFileSync(file, payload, { encoding: "utf-8", mode: 0o600 });
      }
      // mode arg only applies on create; tighten an already-existing file too.
      try {
        chmodSync(file, 0o600);
      } catch {
        /* best-effort */
      }
    } catch (err) {
      logger.warn(`persistActiveModel failed: ${(err as Error).message}`);
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

  /**
   * Apply a field-level disk update and rebase this Engine's matching live
   * bundle onto the returned revision so its next whole-state CAS can proceed.
   */
  private updatePersistedSessionState(sessionId: string, partial: SessionStateFieldPatch): void {
    const stateRevision = this.sessionManager.updateSessionState(sessionId, partial);
    if (this.activeRunSession?.state.sessionId !== sessionId) return;
    Object.assign(this.activeRunSession.state, partial, { stateRevision });
  }

  /**
   * Adopt the exact persisted snapshot that won a Goal-control CAS without
   * discarding counters which the current run has advanced since its previous
   * heartbeat. Merely copying the new stateRevision is unsafe: the next
   * whole-state save would then be allowed to publish stale title/workspace
   * metadata over a concurrent field-level writer.
   */
  private rebaseActiveRunAfterGoalUpdate(live: SessionState, persisted: SessionState): void {
    const runOwned = {
      status: live.status,
      summary: live.summary,
      tokenUsage: live.tokenUsage,
      contextUsageAnchor: live.contextUsageAnchor,
      cumulativePromptTokens: live.cumulativePromptTokens,
      cumulativeCacheReadTokens: live.cumulativeCacheReadTokens,
      cumulativeCacheCreationTokens: live.cumulativeCacheCreationTokens,
      turnCount: live.turnCount,
      turnSeq: live.turnSeq,
      completedThroughEventId: live.completedThroughEventId,
      completedSnapshotVersion: live.completedSnapshotVersion,
      invokedSkills: live.invokedSkills,
      costState: live.costState,
    } satisfies Partial<SessionState>;

    // Optional fields deleted by another writer must disappear locally too;
    // clear before assigning rather than leaving stale own-properties behind.
    for (const key of Object.keys(live)) {
      delete (live as unknown as Record<string, unknown>)[key];
    }
    Object.assign(live, persisted, runOwned);
  }

  private persistGoalTerminal(
    state: SessionState,
    goal: GoalConfig,
    reason: import("../goal/lifecycle.js").PersistedGoalTerminationReason,
  ): boolean {
    return this.persistGoalTerminalOutcome(state, goal, reason) !== "failed";
  }

  private persistGoalTerminalOutcome(
    state: SessionState,
    goal: GoalConfig,
    reason: import("../goal/lifecycle.js").PersistedGoalTerminationReason,
  ): GoalTerminalSaveOutcome {
    const outcome = this.sessionManager.saveGoalTerminalOutcome(state, goal, reason);
    if (outcome === "failed") {
      logger.warn("session.goal_terminal_persist_failed", {
        sessionId: state.sessionId,
        goalId: goal.goalId,
        reason,
      });
    }
    return outcome;
  }

  private persistFinalRunState(state: SessionState): void {
    const finalFields = {
      status: state.status,
      turnCount: state.turnCount,
      turnSeq: state.turnSeq,
      tokenUsage: state.tokenUsage,
      cumulativePromptTokens: state.cumulativePromptTokens,
      cumulativeCacheReadTokens: state.cumulativeCacheReadTokens,
      cumulativeCacheCreationTokens: state.cumulativeCacheCreationTokens,
      contextUsageAnchor: state.contextUsageAnchor,
      costState: state.costState,
      completedSnapshotVersion: state.completedSnapshotVersion,
      completedThroughEventId: state.completedThroughEventId,
    } satisfies SessionStateFieldPatch;
    if (!this.sessionManager.saveStateOrUpdateFields(state, finalFields)) {
      logger.warn("session.final_state_persist_failed", { sessionId: state.sessionId });
    }
  }

  private persistRunProgress(state: SessionState): void {
    const progressFields = {
      status: state.status,
      turnCount: state.turnCount,
      turnSeq: state.turnSeq,
      tokenUsage: state.tokenUsage,
      cumulativePromptTokens: state.cumulativePromptTokens,
      cumulativeCacheReadTokens: state.cumulativeCacheReadTokens,
      cumulativeCacheCreationTokens: state.cumulativeCacheCreationTokens,
      contextUsageAnchor: state.contextUsageAnchor,
      costState: state.costState,
    } satisfies SessionStateFieldPatch;
    if (!this.sessionManager.saveStateOrUpdateFields(state, progressFields)) {
      logger.warn("session.run_progress_persist_failed", { sessionId: state.sessionId });
    }
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
   * (e.g. switching to a capability-contributed preset adds tools) only takes effect on the
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
    const prevPresetName = this.preset.name;
    this.config = { ...this.config, ...patch };
    // #2: re-resolve the prompt-affecting preset so the next-turn PromptComposer
    // (rebuilt per turn from this.preset) reflects the new preset's system
    // prompt / behavior. Only when the preset actually changed.
    if (patch.preset !== undefined && patch.preset !== prevPresetName) {
      const nextPreset = resolveAgentPreset(this.config.preset, this.capabilities);
      // The builtin tool SET is ctor-frozen and may be shared via runtime — we
      // do NOT rebuild it here. If the new preset implies a different builtin
      // tool set, that part of the change only lands on session restart.
      const prevTools = resolveBuiltinToolNames({
        preset: prevPresetName,
        host: this.config.builtinToolHost,
        capabilities: this.capabilities,
      })
        .slice()
        .sort()
        .join(",");
      const nextTools = resolveBuiltinToolNames({
        preset: nextPreset.name,
        host: this.config.builtinToolHost,
        capabilities: this.capabilities,
      })
        .slice()
        .sort()
        .join(",");
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
   * Read a session's persisted active goal WITHOUT resuming it (cheap — reads
   * only state.json via SessionManager.readActiveGoal). The desktop host calls
   * this on session load to re-surface the goal block + its Cancel button: a
   * persistent goal lives only in state.goalLifecycle and is never replayed from
   * the transcript, so after a reload of an aborted goal run the UI would
   * otherwise show nothing (the "goal 还在但页面不显示、取消不了" bug). Returns
   * undefined when the session is unknown or has no active goal.
   */
  getGoal(sessionId: string): GoalConfig | undefined {
    return this.sessionManager.readActiveGoal(sessionId);
  }

  /** True when the current run was built with Goal prompt/tools and can resume in place. */
  canResumeGoalInPlace(sessionId: string): boolean {
    return (
      this.activeTurnLoop !== null &&
      this.activeRunSession?.state.sessionId === sessionId &&
      this.activeRuntimeGoal !== null &&
      this.activeGoalHook !== null
    );
  }

  /**
   * Edit or pause/resume a persisted goal. Mid-run edits use the same step-gap
   * delivery seam as Steer: the current model/tool call is not aborted, and the
   * updated objective is injected before the next model step. Pausing detaches
   * the goal judge and stops this run before another model request is started.
   */
  updateGoal(
    sessionId: string,
    patch: {
      objective?: string;
      paused?: boolean;
      expectedGoalId?: string;
      expectedRevision?: number;
    },
  ): GoalConfig | undefined {
    if (!sessionId || !this.sessionManager.exists(sessionId)) return undefined;
    const live =
      this.activeRunSession?.state.sessionId === sessionId ? this.activeRunSession : null;
    const liveLifecycle = live?.state.goalLifecycle;
    const before =
      liveLifecycle && isGoalLifecycleCurrent(liveLifecycle)
        ? goalConfigFromLifecycle(liveLifecycle)
        : this.sessionManager.readActiveGoal(sessionId);
    if (!before) return undefined;
    if (patch.expectedGoalId !== undefined && before.goalId !== patch.expectedGoalId) {
      return undefined;
    }
    if (patch.expectedRevision !== undefined && (before.revision ?? 1) !== patch.expectedRevision) {
      return undefined;
    }
    const updated = this.sessionManager.updateActiveGoal(sessionId, {
      ...patch,
      expectedGoalId: patch.expectedGoalId ?? before.goalId,
      expectedRevision: patch.expectedRevision ?? before.revision ?? 1,
    });
    if (!updated) return undefined;
    const next = updated.goal;
    if (live) {
      this.rebaseActiveRunAfterGoalUpdate(live.state, updated.state);
    }

    const resumesDormantGoal =
      this.activeTurnLoop !== null &&
      live !== null &&
      before.paused === true &&
      next.paused !== true &&
      this.activeRuntimeGoal === null &&
      this.activeGoalHook !== null;
    if (resumesDormantGoal) {
      // This ordinary run was constructed while the persisted Goal was paused:
      // its system prompt, visible tools and ToolContext are goal-less and
      // cannot be safely hot-swapped. Stop it at the next step boundary; the
      // protocol's conditional resume turn will rebuild a fully Goal-capable
      // run from the now-unpaused persisted state.
      this.activeTurnLoop!.updateGoal(undefined);
    }
    const controlsThisRun =
      this.activeTurnLoop !== null &&
      live !== null &&
      isSameGoalVersion(before, this.activeRuntimeGoal ?? undefined);
    if (controlsThisRun) {
      if (this.activeRuntimeGoal) {
        Object.assign(this.activeRuntimeGoal, next);
        if (next.paused !== true) delete this.activeRuntimeGoal.paused;
      }
      if (this.activePersistedRunGoal) {
        Object.assign(this.activePersistedRunGoal, next);
        if (next.paused !== true) delete this.activePersistedRunGoal.paused;
      }

      if (next.paused === true) {
        if (this.activeGoalHook && this.activeGoalHookAttached) {
          this.hooks.unregister("on_stop", this.activeGoalHook);
          this.activeGoalHookAttached = false;
        }
        this.activeTurnLoop!.updateGoal(undefined);
      } else {
        const objectiveChanged = before.objective !== next.objective;
        const resumed = before.paused === true;
        this.activeTurnLoop!.updateGoal(
          next,
          objectiveChanged
            ? `目标已编辑。新的目标：${next.objective}`
            : resumed
              ? `目标已恢复：${next.objective}`
              : undefined,
          {
            maxTurns: resolveMaxTurns(this.config.maxTurns, next),
            maxStopBlocks: resolveMaxStopBlocks(this.config.maxStopBlocks, next),
          },
        );
        if (this.activeGoalHook && !this.activeGoalHookAttached) {
          this.hooks.register("on_stop", this.activeGoalHook, 0, "goal-stop");
          this.activeGoalHookAttached = true;
        }
      }
    }
    return next;
  }

  /**
   * Clear a session's persisted active goal (CC `/goal clear`). Works whether
   * the session is idle or its goal run is in flight: it wipes
   * `state.goalLifecycle` (so the next bare send won't re-inherit it) and, if a
   * goal hook is currently registered for this engine, unregisters it so an
   * in-flight run can stop instead of being re-blocked by the now-cleared goal.
   * Returns true if a goal was actually cleared. Idempotent — clearing a
   * session with no active goal is a no-op returning false.
   */
  clearGoal(sessionId: string, expected?: { goalId?: string; revision?: number }): boolean {
    if (!this.sessionManager.exists(sessionId)) return false;
    // Prefer the LIVE run's bundle when it's this session so the domain update
    // rebases the exact state object used by subsequent progress writes.
    const live =
      this.activeRunSession && this.activeRunSession.state.sessionId === sessionId
        ? this.activeRunSession
        : null;
    const session = live ?? this.sessionManager.resume(sessionId);
    const lifecycle = session.state.goalLifecycle;
    const currentGoal =
      lifecycle && isGoalLifecycleCurrent(lifecycle)
        ? goalConfigFromLifecycle(lifecycle)
        : undefined;
    const had = currentGoal !== undefined;
    let controlsThisRun = false;
    if (
      had &&
      ((expected?.goalId !== undefined && currentGoal?.goalId !== expected.goalId) ||
        (expected?.revision !== undefined && (currentGoal?.revision ?? 1) !== expected.revision))
    ) {
      return false;
    }
    if (had) {
      const clearedGoal = currentGoal!;
      controlsThisRun =
        this.activeTurnLoop !== null &&
        live !== null &&
        isSameGoalVersion(clearedGoal, this.activeRuntimeGoal ?? undefined);
      if (!this.persistGoalTerminal(session.state, clearedGoal, "user_cleared")) return false;
      // A cross-writer edit may have won between the expected-version check
      // above and saveGoalTerminal's conflict merge. In that case the old
      // revision's tombstone is durable but the newer active revision remains;
      // report a stale delete, and never stop/detach the run that owns it.
      if (session.state.goalLifecycle && isGoalLifecycleCurrent(session.state.goalLifecycle)) {
        return false;
      }
      // A paused Goal inherited by an ordinary run is only dormant persisted
      // state; deleting it must not cancel that unrelated conversation.
      if (controlsThisRun) this.activeTurnLoop!.updateGoal(undefined);
    }
    // If THIS session's goal run is in flight, drop its stop hook so the
    // current run can terminate (the closure-held goal would otherwise keep
    // re-blocking). The run's own `finally` also unregisters; double-unregister
    // is safe (set delete is idempotent).
    if (
      had &&
      this.activeGoalHook &&
      this.lastSessionId === sessionId &&
      (controlsThisRun || this.activeRuntimeGoal === null)
    ) {
      if (this.activeGoalHookAttached) this.hooks.unregister("on_stop", this.activeGoalHook);
      this.activeGoalHook = null;
      this.activeGoalHookAttached = false;
      this.activeRuntimeGoal = null;
      this.activePersistedRunGoal = null;
    }
    return had;
  }

  /**
   * Persist a workspace pointer through the Engine that owns the live bundle.
   * Host-side workspace actions use this RPC-facing seam so advancing the disk
   * revision also rebases the active run before its next progress write.
   */
  setSessionWorkspace(sessionId: string, workspace: SessionWorkspace): SessionWorkspace | null {
    if (!sessionId || !this.sessionManager.exists(sessionId)) return null;
    try {
      const stateRevision = this.sessionManager.setSessionWorkspace(sessionId, workspace);
      if (this.activeRunSession?.state.sessionId === sessionId) {
        Object.assign(this.activeRunSession.state, { workspace, stateRevision });
      }
      return workspace;
    } catch {
      return null;
    }
  }

  /**
   * Reset a session's workspace pointer back to its main root. If the session is
   * actively running, mutate that live SessionBundle first so the run's next
   * saveState cannot resurrect a stale worktree pointer.
   */
  releaseSessionWorkspace(sessionId: string): SessionWorkspace | null {
    if (!sessionId || !this.sessionManager.exists(sessionId)) return null;
    const mainRoot =
      this.sessionManager.readSessionMainRoot(sessionId) ??
      (this.activeRunSession?.state.sessionId === sessionId
        ? this.activeRunSession.state.cwd
        : undefined);
    if (!mainRoot) return null;
    return this.setSessionWorkspace(sessionId, { root: mainRoot, kind: "main" });
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
   * Force context compaction on a session.
   * Returns token stats before/after.
   */
  async forceCompact(sessionId?: string): Promise<{
    before: number;
    after: number;
    strategy: "none (no active session)" | "no compaction needed" | "compacted" | CompactStrategy;
  }> {
    const effectiveSessionId = sessionId ?? this.lastSessionId;
    if (!effectiveSessionId) {
      return { before: 0, after: 0, strategy: "none (no active session)" };
    }

    const session = this.sessionManager.resume(effectiveSessionId);
    const sourceMessages =
      this.compactedMessagesBySession.get(effectiveSessionId) ?? session.transcript.toMessages();
    const before = estimateTokens(sourceMessages);

    let contextManager = this.lastContextManager;
    if (!contextManager || this.lastSessionId !== effectiveSessionId) {
      contextManager = new ContextManager({
        maxTokens: this.resolveMaxContextTokens(),
        ...Object.fromEntries(
          Object.entries(this.resolveContextRatios()).filter(([, v]) => v !== undefined),
        ),
      });
      contextManager.setTranscriptPath(session.transcript.getFilePath());
      contextManager.initReplacementStateFromMessages(sourceMessages);
      this.lastContextManager = contextManager;
    }
    // Manual /compact emits its UI boundary at the protocol layer from the
    // final before/after result. Capture the tier here, but avoid reusing a
    // stale run callback retained on lastContextManager, which could otherwise
    // double-emit.
    let compactStrategy: CompactStrategy | undefined;
    contextManager.setOnCompact((info) => {
      if (info.after < info.before) compactStrategy = info.strategy;
    });

    // Manual /compact = maximum compaction NOW. The automatic ladder waits for
    // compactAtRatio (0.85 * window), so on a 1M-window model an 800k text-only
    // conversation sits under the gate and manage() only runs a no-op micro.
    // Wire a summarizeFn (the run path does this per-run; a cold forceCompact on
    // a resumed-but-never-run session has none) and call forceSummarize, which
    // ignores the ratio gate and always summarizes (falling back to snip/window).
    //
    // Use the PRIMARY model, not the aux model. Automatic background compaction
    // routes to aux to keep the high-frequency path cheap, but summarization is
    // a high-fidelity task (drop a decision and the conversation "forgets"), and
    // a manual /compact is a low-frequency, user-initiated request for quality.
    // The aux model is sized for tiny outputs (titles, memory extraction), so
    // downgrading the one compaction the user explicitly asked for is backwards.
    try {
      const primaryClient = await createLLMClient(this.config.llm, this.config.clientDefaults);
      Object.assign(
        session.state,
        normalizeCumulativeUsageCounters(session.state, session.state.tokenUsage),
      );
      const recordCompactUsage = (usage: TokenUsage): CumulativeUsageCounters => {
        this.sessionManager.recordAuxiliaryUsage(
          effectiveSessionId,
          usage,
          this.config.costStore?.serialize() as Record<string, unknown> | undefined,
        );
        const latest = this.sessionManager.resume(effectiveSessionId).state;
        const next = normalizeCumulativeUsageCounters(latest, latest.tokenUsage);
        Object.assign(session.state, next, {
          tokenUsage: latest.tokenUsage,
          costState: latest.costState,
          stateRevision: latest.stateRevision,
        });
        return next;
      };
      contextManager.setSummarizeFn(this.buildSummarizeFn(primaryClient, recordCompactUsage));
    } catch (err) {
      logger.warn("engine.force_compact_client_failed", {
        error: (err as Error).message,
      });
    }

    const compacted = await contextManager.forceSummarize(sourceMessages);
    const after = estimateTokens(compacted);
    this.compactedMessagesBySession.set(effectiveSessionId, compacted);
    this.lastSessionId = effectiveSessionId;
    this.lastMessages = compacted;
    return {
      before,
      after,
      strategy: after >= before ? "no compaction needed" : (compactStrategy ?? "compacted"),
    };
  }

  private recordCacheReadDiagnostics(sessionId: string, sample: PromptCacheDiagnosticSample): void {
    const result = this.promptCacheDiagnostics.record(sessionId, sample);
    if (result.kind === "scope_changed") {
      logger.info("engine.cache_scope_changed", {
        sessionId,
        cacheScopeHash: sample.fingerprint.cacheScopeHash,
      });
      return;
    }
    if (result.kind === "schema_changed") {
      logger.info("engine.cache_diagnostic_schema_changed", {
        sessionId,
        version: sample.fingerprint.version,
      });
      return;
    }
    if (result.kind !== "drop") return;

    logger.warn("engine.cache_read_drop", {
      sessionId,
      previousCacheReadTokens: result.previous.cacheReadTokens,
      currentCacheReadTokens: result.current.cacheReadTokens,
      dropRatio: result.dropRatio,
      cause: result.attribution.cause,
      changedPrefixes: result.attribution.changedPrefixes,
      previousPrefix: result.previous.fingerprint,
      currentPrefix: result.current.fingerprint,
      hint: promptCacheDropHint(result.attribution),
    });
  }

  private getSettingsManager(): SettingsManager {
    if (!this.settingsManager) {
      this.settingsManager = new SettingsManager(
        this.config.cwd,
        this.config.settingsScope ?? "project",
        this.config.projectTrusted !== false,
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
   * Read a settings value by dotted key (e.g. "capabilities.foo.enabled").
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

  /**
   * Switch permission mode at runtime. Idle updates apply immediately; busy
   * updates are committed atomically when the current run settles, so its
   * classifier and ToolContext retain the immutable start-of-run snapshot.
   * Session-only — does not persist to settings.
   */
  setPermissionMode(mode: NonNullable<EngineConfig["permissionMode"]>): void {
    this.permissionController.setPermissionMode(mode);
  }

  getPermissionMode(): NonNullable<EngineConfig["permissionMode"]> {
    return this.permissionController.getPermissionMode();
  }

  /**
   * Extend the in-flight run's turn ceiling and/or goal budgets (TODO 3.1 —
   * 运行中续轮/加预算). No-op (returns null) when no run is active. Lets a user
   * keep an unattended goal going past its original cap instead of restarting.
   */
  extendGoalRun(opts: GoalExtension): {
    maxTurns: number;
    tokenBudget?: number;
    timeBudgetMs?: number;
    maxStopBlocks: number;
  } | null {
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
    return this.permissionController.getPermissionRules();
  }

  /**
   * Toggle plan mode directly. Called by the Plan tool (Task 7) via ToolContext.engine.
   * Also syncs permissionMode to keep both fields consistent.
   */
  setPlanMode(value: boolean): void {
    this.permissionController.setPlanMode(value);
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
  private getAgentDefinitions(
    cwd: string,
    explicitProfileOverrides?: CapabilityOverrides,
  ): AgentDefinitionRegistry {
    const disabledAgents = this.readDisabledAgents(cwd, explicitProfileOverrides);
    const disabledPlugins = this.readDisabledLists(cwd, explicitProfileOverrides).disabledPlugins;
    const disabledKey = [...disabledAgents, "::", ...disabledPlugins].slice().sort().join(" ");
    if (this.agentDefsCache?.cwd !== cwd || this.agentDefsCache.disabledKey !== disabledKey) {
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
  private readDisabledAgents(
    cwd?: string,
    explicitProfileOverrides?: CapabilityOverrides,
  ): string[] {
    try {
      const sm = this.getSettingsManager();
      const settings = sm.get() as { disabledAgents?: string[] };
      const baseline = Array.isArray(settings.disabledAgents) ? settings.disabledAgents : [];
      const overrides = effectiveProjectOverrides(sm, cwd, explicitProfileOverrides);
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
    explicitProfileOverrides?: CapabilityOverrides,
  ): Record<string, CapabilityOverride> | undefined {
    if (this.config.isSubAgent === true || !cwd) return undefined;
    try {
      const overrides = effectiveProjectOverrides(
        this.getSettingsManager(),
        cwd,
        explicitProfileOverrides,
      );
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
  buildToolContext(
    cwd = this.config.cwd ?? process.cwd(),
    explicitProfileOverrides?: CapabilityOverrides,
    profileMemoryDir?: string,
  ): ToolContext {
    const { disabledSkills, disabledPlugins } = this.readDisabledLists(
      cwd,
      explicitProfileOverrides,
    );
    const capabilityServices = Object.fromEntries(
      this.capabilities.flatMap((capability) => {
        if (!capability.createToolService) return [];
        const service = capability.createToolService({
          isSubAgent: this.config.isSubAgent === true,
          settings: this.getSettingsManager(),
          resolveSandbox: (cwd) => this.runEnvironmentResolver.resolveSandbox(cwd),
          readShellEnv: (cwd) => this.runEnvironmentResolver.readShellEnv(cwd),
          getSessionManager: () => this.sessionManager,
        });
        return [[capability.id, service] as const];
      }),
    );
    const ctx: ToolContext = {
      shellEnv: this.runEnvironmentResolver.readShellEnv(cwd),
      cwd,
      profileMemoryDir,
      llmConfig: this.config.llm,
      modelPool: this.modelPool,
      toolRegistry: this.toolRegistry,
      capabilityServices,
      askUser: this.config.askUser,
      browser: this.config.browserBridge,
      workspace: this.config.workspaceBridge,
      panels: this.config.panelBridge,
      injectCredentialToBrowser: this.config.injectCredentialToBrowser,
      isSubAgent: this.config.isSubAgent === true,
      // Credential tools narrow their disk reads to this scope: a project/
      // isolated engine (SDK-embedded) must not surface the host user's
      // ~/.code-shell credentials or credentialUse.autoApprove. "full" (the
      // host-application default) merges user + project as before.
      settingsScope: this.config.settingsScope ?? "project",
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
    ctx.setCwd = (cwd: string) => {
      ctx.cwd = cwd;
    };
    return ctx;
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
  private readDisabledLists(
    cwd = this.config.cwd,
    explicitProfileOverrides?: CapabilityOverrides,
  ): {
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
    return computeEffectiveDisabledLists(this.getSettingsManager(), cwd, explicitProfileOverrides);
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
    return this.auxiliaryPipeline.readMemoriesConfig();
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

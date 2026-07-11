/**
 * Engine — the main facade that wires all components together.
 */

import type {
  ClientDefaults,
  Message,
  StreamCallback,
  TaskInfo,
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
import {
  addTokenUsage,
  addCumulativeUsage,
  cumulativeCacheHitRate,
  foldRunUsage,
  normalizeCumulativeUsageCounters,
  type CumulativeUsageCounters,
} from "./session-usage.js";
import {
  enqueueSteerItem,
  consumeSteerItems,
  removeSteerItem,
  type SteerItem,
} from "./steer-queue.js";
import { RunEnvironmentResolver } from "./run-environment.js";
import { BUILTIN_TOOL_GUARDS, type BuiltinToolFn } from "../tool-system/builtin/index.js";
import { asyncAgentRegistry } from "../tool-system/builtin/agent-registry.js";
import { backgroundShellManager } from "../runtime/background-shell.js";
import {
  notificationQueue,
  buildNotificationMessage,
} from "../tool-system/builtin/agent-notifications.js";
import {
  PermissionClassifier,
  InteractiveApprovalBackend,
} from "../tool-system/permission.js";
import { HookRegistry } from "../hooks/registry.js";
import type { HookEventName, HookResult } from "../hooks/events.js";
import type { HookHandler } from "../hooks/registry.js";
import { wrapHookMessages } from "../hooks/inject.js";
import { createGoalStopHook, type GoalJudgeRuntimeContext } from "../hooks/goal-stop-hook.js";
import {
  normalizeGoal,
  resolveGoalSetAt,
  resolveMaxTurns,
  resolveMaxStopBlocks,
  isSameGoalInstance,
  type GoalConfig,
  type GoalExtension,
  type GoalTerminationReason,
} from "./goal.js";
import { loadPluginHooks } from "../plugins/loadPluginHooks.js";
import { pluginAgentDirs } from "../plugins/installer/loadPluginAgents.js";
import { patchOrphanedToolUses } from "./patch-orphaned-tools.js";
import { runShellHook, shellHookMatches } from "../hooks/shell-runner.js";
import { ContextManager, type CompactStrategy } from "../context/manager.js";
import {
  estimateTokens,
  clampContextRatios as clampContextRatiosImpl,
} from "../context/compaction.js";
import { PLAN_MODE_ALLOWED_TOOLS } from "../tool-system/plan-mode-allowlist.js";
import { PromptComposer } from "../prompt/composer.js";
import {
  SessionManager,
  type ForkSessionOptions,
  type ForkSessionResult,
  type SessionBundle,
} from "../session/session-manager.js";
import { ModelFacade } from "./model-facade.js";
import { logger, runWithSid, getCurrentSid } from "../logging/logger.js";
import { recordSessionStart, recordSessionEnd } from "../logging/session-recorder.js";
import { sanitizeTaskString } from "../logging/sanitize-messages.js";
import { TurnLoop } from "./turn-loop.js";
import type { AskUserFn } from "../tool-system/builtin/ask-user.js";
import { MCPManager } from "../tool-system/mcp-manager.js";
import { SettingsManager, userHome } from "../settings/manager.js";
import { getCredentialAccess } from "../credentials/access.js";
import type { CapabilityOverride, CapabilityOverrides } from "../settings/schema.js";
import {
  isFeatureEnabled,
  resolveFeatureFlags,
  type FeatureFlagName,
  type FeatureFlagOverrides,
} from "../settings/feature-flags.js";
import { effectiveDisabledList, effectiveBuiltinLists } from "../capability-control/overlay.js";
import { computeEffectiveDisabledLists } from "../capability-control/disabled-lists.js";
import { registerFileHistoryHook } from "./file-history-hook.js";
import type { ToolContext } from "../tool-system/context.js";
import type { SandboxBackend } from "../tool-system/sandbox/index.js";
import { resolveAgentPreset, resolveBuiltinToolNames, type AgentPreset } from "../preset/index.js";
import { ModelPool, type ModelEntry } from "../llm/model-pool.js";
import { AgentDefinitionRegistry } from "../agent/agent-definition-registry.js";
import { defaultCacheDir } from "../llm/model-cache.js";
import { detectProviderFromApiKey, buildModelPool } from "../onboarding.js";
import { detectPastedNoise } from "../utils/task-sanitizer.js";
import { formatFriendlyError } from "./friendly-error.js";
import { buildSessionTitle } from "./session-title.js";
import {
  PromptCacheDiagnosticRecorder,
  promptCacheDropHint,
  type PromptCacheDiagnosticSample,
} from "./prompt-cache-diagnostics.js";
import { EngineRuntime } from "./runtime.js";
import { buildRunUserMessageContent, prepareRunImageInput } from "./run-image-input.js";
import type { EngineRunOptions } from "./run-types.js";
import { createSubAgentSpawner } from "./subagent-spawner.js";
import { stripInjectedContextMessages } from "./run-finalizer.js";
import { AuxiliaryPipeline } from "./auxiliary-pipeline.js";
import { PermissionController } from "./permission-controller.js";
import { join } from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { InputAttachmentMeta } from "../protocol/types.js";

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
// settings/disk-defaults, SDK index) can import them without dragging in this
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
export { diskDefaultsFrom, type DiskDefaultPatch } from "../settings/disk-defaults.js";

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

/**
 * Load reusable sub-agent role definitions, merging:
 *   1. project-level  <cwd>/.code-shell/agents/*.md   (ships built-ins)
 *   2. user-level     ~/.code-shell/agents/*.md        (user wins on name)
 * Names in `disabledAgents` are filtered out so the LLM never sees them.
 */
/**
 * Resolve the working directory for a run. Precedence for legacy sessions:
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
  /**
   * The in-flight run's session bundle, held so clearGoal() can wipe the goal
   * on the SAME instance the run loop is persisting each turn — not a fresh
   * detached copy from resume(). Without this, a mid-run 清除 clears disk, but
   * the still-running loop's next saveState(bundle.state) resurrects the goal
   * (bundle.state.activeGoal was never dropped). A never-completing goal run
   * (judge keeps returning not_met → continueSession) stays live for a long
   * time, so this write-back race is the norm, not an edge case, for such runs.
   * Single-valued like activeTurnLoop — one top-level run per engine at a time.
   * Null when idle; set at run start, cleared in run's finally.
   */
  private activeRunSession: SessionBundle | null = null;
  /**
   * Same-instance run guard. Engine owns single-valued live controls and one
   * HookRegistry, so a second run must not enter until the first has completed
   * all state persistence and end hooks. This prevents handle contamination and
   * whole-state saveState overlap only within this Engine instance. It does not
   * coordinate different Engine instances sharing a sessionId, Workers, or
   * processes; session-level locking/CAS for those cases is a separate finding.
   */
  private runInProgress = false;
  /** Permission update requested while runInProgress. Applied in run() finally. */

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

    this.preset = resolveAgentPreset(config.preset);
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
    this.toolRegistry =
      config.runtime?.toolRegistry ??
      new ToolRegistry({
        builtinTools: resolveBuiltinToolNames({
          preset: this.preset.name,
          host: config.builtinToolHost,
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

  private async runExclusive(task: string, options?: EngineRunOptions): Promise<EngineResult> {
    // Freeze permission context once, before the first await. Per-turn protocol
    // overrides live only for this run; persistent setPermissionMode/setPlanMode
    // calls made while busy are staged separately and cannot mutate this pair.
    let runPermissionMode = options?.permissionMode ?? this.config.permissionMode ?? "acceptEdits";
    if (options?.planMode === true) {
      runPermissionMode = "plan";
    } else if (options?.planMode === false && runPermissionMode === "plan") {
      runPermissionMode = "acceptEdits";
    }
    const runPlanMode = runPermissionMode === "plan";
    const workspaceResume =
      options?.sessionId && this.sessionManager.exists(options.sessionId)
        ? await this.sessionManager.resolveSessionWorkspaceForResume(options.sessionId)
        : undefined;
    if (workspaceResume && !workspaceResume.ok) {
      return {
        text: `ERROR: ${workspaceResume.message}`,
        reason: "completed",
        sessionId: options!.sessionId!,
        turnCount: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    }
    if (
      workspaceResume?.ok &&
      workspaceResume.reason === "worktree_missing_branch_gone" &&
      workspaceResume.message
    ) {
      return {
        text: workspaceResume.message,
        reason: "completed",
        sessionId: options!.sessionId!,
        turnCount: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    }

    // Existing P1 sessions resolve cwd from SessionWorkspace, even if the host
    // passes a stale cwd. Legacy sessions without workspace keep the historical
    // explicit-cwd precedence for backward compatibility.
    const workspaceCwd =
      workspaceResume?.ok && workspaceResume.reason !== "legacy" ? workspaceResume.cwd : undefined;
    const sessionCwd =
      workspaceCwd === undefined && options?.cwd === undefined && options?.sessionId
        ? workspaceResume?.ok
          ? workspaceResume.cwd
          : this.sessionManager.readCwd(options.sessionId)
        : undefined;
    const cwd =
      workspaceCwd ??
      resolveRunCwd({
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

    // Build the per-Engine ToolContext that will be threaded through every
    // tool call. Replaces the old module-level singletons (setAskUserFn,
    // setArenaLLMConfig, setSubAgentConfig, setToolSearchRegistry).
    const subAgentSpawner = createSubAgentSpawner({
      parentConfig: this.config,
      presetName: this.preset.name,
      cwd,
      permissionMode: runPermissionMode,
      modelPool: this.modelPool,
      parentStream: options?.onStream,
      appendParentSubagent: (agentId, description) => {
        session.transcript.appendSubagent(agentId, undefined, description);
      },
      sessionExists: (sessionId) => this.sessionManager.exists(sessionId),
      childRunner: {
        runChild: async (config, childTask, childOptions) => {
          const child = new Engine(config);
          return child.run(childTask, childOptions);
        },
      },
    });

    const sandboxConfig = this.runEnvironmentResolver.resolveSandboxConfig(cwd);
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

    // sessionId is filled in after the session bundle is resolved below
    // (the session may be cold-started or resumed). Until then this is
    // intentionally shaped as a mutable local; we treat it as immutable
    // after the assignment.
    const toolCtx: ToolContext = {
      ...this.buildToolContext(),
      approvalRouter: options?.approvalRouter ?? this.config.approvalRouter,
      permissionMode: runPermissionMode,
      planMode: runPlanMode,
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
      shellEnv: this.runEnvironmentResolver.readShellEnv(cwd),
      // TodoWrite reads this to push task_update events independently
      // of its return value, so the UI's pinned task panel refreshes
      // immediately rather than after the LLM next surfaces the
      // snapshot. wrappedOnStream snoops the same channel to keep
      // latestTodos current for TaskGuard.
      streamCallback: options?.onStream,
      setCwd(nextCwd: string) {
        toolCtx.cwd = nextCwd;
      },
    };

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
    let session: SessionBundle;
    let messages: Message[];
    let freshImageMessage: Message | undefined;
    let resumedFromDisk = false;
    const claimedClientMessageIds = new Set<string>();
    const claimClientMessageId = (
      bundle: SessionBundle,
      clientMessageId: string | undefined,
      source: "submit" | "steer",
    ): boolean => {
      if (!clientMessageId) return true;
      if (
        claimedClientMessageIds.has(clientMessageId) ||
        bundle.transcript.hasClientMessageId(clientMessageId)
      ) {
        logger.info("engine.client_message.duplicate_ignored", {
          sessionId: bundle.state.sessionId,
          clientMessageId,
          source,
        });
        return false;
      }
      claimedClientMessageIds.add(clientMessageId);
      return true;
    };

    if (options?.sessionId && this.sessionManager.exists(options.sessionId)) {
      resumedFromDisk = true;
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
      if (!claimClientMessageId(session, options?.clientMessageId, "submit")) {
        const usage = session.state.tokenUsage ?? {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        };
        return {
          text: "",
          reason: "completed",
          sessionId: session.state.sessionId,
          turnCount: session.state.turnCount ?? 0,
          usage: {
            promptTokens: usage.promptTokens ?? 0,
            completionTokens: usage.completionTokens ?? 0,
            totalTokens: usage.totalTokens ?? 0,
          },
        };
      }
      if (parsedTask.hasImages) freshImageMessage = userMsg;
      messages.push(userMsg);
      session.transcript.appendMessage("user", userMessageContent, {
        injected: options?.injected === true,
        clientMessageId: options?.clientMessageId,
      });
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
      const userMsg: Message = { role: "user", content: userMessageContent };
      claimClientMessageId(session, options?.clientMessageId, "submit");
      if (parsedTask.hasImages) freshImageMessage = userMsg;
      messages = [userMsg];
      session.transcript.appendMessage("user", userMessageContent, {
        clientMessageId: options?.clientMessageId,
      });
      // Save first user message as session summary — text only. The summary
      // shows up in the session list; "[image]" is more informative than a
      // truncated `[object Object]` when the prompt was purely visual.
      const summarySrc = parsedTask.hasImages
        ? parsedTask.text ||
          `[image${parsedTask.images.length > 1 ? `s × ${parsedTask.images.length}` : ""}]`
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
    toolCtx.setSessionWorkspace = (workspace) => {
      session.state.workspace = workspace;
    };
    const sessionRun = runWithSid(session.state.sessionId, async () => {
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
        "user_prompt_submit",
        {
          sessionId: session.state.sessionId,
          // Pass the text-only portion. Handlers reading the prompt for keyword
          // detection / classification (e.g. superpowers' "did the user ask
          // about X?") don't gain anything from megabytes of base64 inlined here,
          // and silently leaking attachment bytes through hooks is the kind of
          // exfiltration risk a curious user-installed shell hook shouldn't carry.
          prompt: taskText,
          resumed: resumedFromDisk,
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

      const contextManager = new ContextManager({
        maxTokens: this.resolveMaxContextTokens(),
        // Drop undefined fields so they don't clobber ContextManager defaults
        // (spread of `{x: undefined}` would override the default with undefined).
        ...Object.fromEntries(
          Object.entries(this.resolveContextRatios()).filter(([, v]) => v !== undefined),
        ),
      });
      this.lastContextManager = contextManager;

      const persistedContextAnchor = session.state.contextUsageAnchor;
      const contextAnchorCompatible =
        persistedContextAnchor !== undefined &&
        (persistedContextAnchor.provider === undefined ||
          persistedContextAnchor.provider === this.config.llm.provider) &&
        (persistedContextAnchor.model === undefined ||
          persistedContextAnchor.model === this.config.llm.model) &&
        (persistedContextAnchor.messageCount <= messages.length ||
          persistedContextAnchor.estimateAtAnchor !== undefined);
      if (contextAnchorCompatible) {
        contextManager.seedActualUsage(persistedContextAnchor);
      }

      // Best-effort token estimate of the full prompt so the UI's ctx bar isn't
      // 0% before the first real usage_update arrives. The authoritative count
      // comes from `usage.promptTokens` after the first LLM response — this is
      // just a display-friendly approximation for the first frame, annotated
      // with source/confidence so consumers don't treat heuristics as truth.
      //
      // Only seed once per (process, sid). On subsequent turns the UI already
      // shows the previous turn's accurate ctx; overwriting it with a fresh
      // best-effort estimate would make the bar visibly drop on every submit.
      const sid = session.state.sessionId;
      const needsCtxSeed = !this.ctxSeedSent.has(sid);
      const ctxSeed = needsCtxSeed
        ? (() => {
            const checked = contextManager.checkLimits(messages);
            return {
              tokens: checked.tokens,
              source: checked.promptTokensSource,
              confidence: checked.promptTokensConfidence,
            };
          })()
        : {
            tokens: 0,
            source: "heuristic_estimate" as const,
            confidence: "low" as const,
          };
      if (needsCtxSeed) this.ctxSeedSent.add(sid);

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
          latestTodos = snap;
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
      const { rules: defaultRules, backend: approvalBackend } = this.permissionController.build(
        mode,
        cwd,
        toolCtx.approvalRouter,
      );

      const permission = new PermissionClassifier(defaultRules, mode, approvalBackend);
      this.permissionController.attach(permission, toolCtx.approvalRouter);

      // If the backend is the interactive one, wire it for project-scope
      // persistence: it needs cwd to find settings.local.json, and a callback
      // to apply newly-saved rules to the live classifier so subsequent calls
      // in this same session don't re-prompt. Headless/auto backends skip
      // this — they don't prompt, so there are no project rules to persist.
      if (approvalBackend instanceof InteractiveApprovalBackend) {
        approvalBackend.setSessionContext(session.state.sessionId, {
          cwd,
          onProjectRules: (rules) => {
            // Prepend the *full* accumulated list of session-saved project rules
            // so user approvals win over defaults and earlier approvals aren't
            // dropped when later ones come in.
            permission.reconfigure(mode, approvalBackend, [...rules, ...defaultRules]);
          },
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
        goalToolState: {
          hasGoal:
            this.config.isSubAgent !== true &&
            (normalizeGoal(options?.goal) !== undefined ||
              session.state.activeGoal !== undefined ||
              normalizeGoal(this.config.goal) !== undefined),
        },
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
      const toolVisibility = {
        cwd: guardCwd,
        hasGoal:
          this.config.isSubAgent !== true &&
          (normalizeGoal(options?.goal) !== undefined ||
            session.state.activeGoal !== undefined ||
            normalizeGoal(this.config.goal) !== undefined),
        settingsScope: this.config.settingsScope ?? "project",
      };
      toolCtx.toolVisibility = toolVisibility;
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
        const registryNames = new Set(this.toolRegistry.getToolDefinitions().map((t) => t.name));
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
        const reg = this.toolRegistry.getTool(toolName) as {
          source?: string;
          serverName?: string;
        } | null;
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
          return guard ? guard(toolVisibility) : true;
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
      const toolDefs = runPlanMode
        ? allToolDefs.filter((t) => PLAN_MODE_ALLOWED_TOOLS.has(t.name))
        : allToolDefs;

      const [llmClient, fullSystemPrompt, dynamicContextMsg] = await Promise.all([
        llmClientPromise,
        // System prompt is now the STABLE prefix only — skills + git status moved
        // out to a trailing per-turn message so they no longer bust the cache.
        promptComposer.buildSystemPrompt(toolDefs),
        promptComposer.buildDynamicContextMessage(),
      ]);

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

      // Volatile context (skills + git status) goes at the very END — after the
      // user task — so it sits past the conversation's cache breakpoint. A change
      // here (new skill, edited file) never invalidates the cached history prefix.
      if (dynamicContextMsg) {
        messages.push(dynamicContextMsg);
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
      // Two summarizers with DIFFERENT quality needs:
      //
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
      let turnLoop!: TurnLoop;
      let autoCompactionGoalTermination: ReturnType<TurnLoop["recordGoalJudgeUsage"]>;
      let externalRunUsage: TokenUsage = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };
      let runAccountingFinalized = false;
      Object.assign(
        session.state,
        normalizeCumulativeUsageCounters(session.state, session.state.tokenUsage),
      );
      const recordCumulativeUsage = (usage: TokenUsage): CumulativeUsageCounters => {
        const next = addCumulativeUsage(session.state, usage);
        Object.assign(session.state, next);
        return next;
      };
      const recordExternalBilledUsage = (usage: TokenUsage): CumulativeUsageCounters => {
        externalRunUsage = addTokenUsage(externalRunUsage, usage);
        const cumulative = recordCumulativeUsage(usage);
        autoCompactionGoalTermination = turnLoop.recordGoalJudgeUsage(usage);
        if (runAccountingFinalized) {
          try {
            const latest = this.sessionManager.resume(sid).state;
            const lateCumulative = addCumulativeUsage(latest, usage);
            this.sessionManager.updateSessionState(sid, {
              tokenUsage: addTokenUsage(latest.tokenUsage, usage),
              ...lateCumulative,
              ...(this.config.costStore
                ? {
                    costState: this.config.costStore.serialize() as Record<string, unknown>,
                  }
                : {}),
            });
          } catch (err) {
            logger.warn("engine.late_usage_persist_failed", {
              sessionId: sid,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return cumulative;
      };
      contextManager.setSummarizeFn(this.buildSummarizeFn(llmClient, recordExternalBilledUsage));

      // Create components (requires resolved llmClient).
      const modelFacade = new ModelFacade(llmClient, session.transcript);
      const getRunUsage = () => {
        const visible = modelFacade.getUsage();
        return {
          ...visible,
          totalPromptTokens: visible.totalPromptTokens + externalRunUsage.promptTokens,
          totalCompletionTokens: visible.totalCompletionTokens + externalRunUsage.completionTokens,
          totalTokens: visible.totalTokens + externalRunUsage.totalTokens,
          totalCacheReadTokens:
            visible.totalCacheReadTokens + (externalRunUsage.cacheReadTokens ?? 0),
          totalCacheCreationTokens:
            visible.totalCacheCreationTokens + (externalRunUsage.cacheCreationTokens ?? 0),
        };
      };
      const callPrimaryModel = modelFacade.call.bind(modelFacade);
      modelFacade.call = async (...args: Parameters<ModelFacade["call"]>) => {
        // A primary-model summary may itself exhaust the Goal budget. Do not
        // issue the main turn request after that billed sub-call; return control
        // to TurnLoop, whose existing post-response guard emits and persists the
        // canonical goal_budget_exhausted termination.
        if (autoCompactionGoalTermination) {
          return {
            text: "",
            toolCalls: [],
            stopReason: "stop",
          };
        }
        return callPrimaryModel(...args);
      };

      // Session-cumulative usage baseline: the LLM client is recreated per run
      // (its getUsage() counts only THIS run), so to accumulate across runs we
      // capture the persisted total at run start and fold this run's usage onto
      // it (see foldRunUsage). Snapshot now, before any turn boundary fires.
      const usageBaseline: TokenUsage = { ...session.state.tokenUsage };

      // Wire getOutputTokens for token budget tracking
      modelFacade.getOutputTokens = () => {
        const usage = getRunUsage();
        return usage.totalCompletionTokens;
      };

      // Wire summarize for tool use summaries (uses lightweight call). Keep the
      // request out of the foreground tracker while billing and reporting it to
      // the owning session/Goal budget.
      modelFacade.summarize = async (sysPrompt: string, userMsg: string) => {
        const resp = await auxSummaryClient.createMessage({
          systemPrompt: sysPrompt,
          messages: [{ role: "user", content: userMsg }],
          tools: [],
          maxTokens: 256,
          billingEnabled: true,
          requestVisible: false,
          // Auxiliary call — see contextManager.setSummarizeFn above.
          reasoning: { mode: "off" },
        });
        if (resp.usage) recordExternalBilledUsage(resp.usage);
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

      const sessionDir = join(
        this.config.sessionStorageDir ?? join(userHome(), ".code-shell", "sessions"),
        session.state.sessionId,
      );
      const fileHistoryHook = registerFileHistoryHook({
        hooks: this.hooks,
        sessionDir,
        cwd,
        getTurnSeq: () => session.state.turnSeq,
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
      //   2. session.state.activeGoal — a goal set on an earlier send.
      //   3. config.goal — engine-level default (rare; e.g. headless).
      // When (1) supplies a goal that differs from the stored one we REPLACE the
      // persisted active goal (one active goal per session) and announce it. A
      // bare send with no options.goal inherits the stored active goal so the
      // model keeps working toward it — that's what makes it persistent.
      const explicitGoal = normalizeGoal(options?.goal);
      let storedGoal = this.config.isSubAgent !== true ? session.state.activeGoal : undefined;
      // Defense in depth: a stale whole-state writer may have restored the
      // activeGoal field after this exact goal instance was force-terminated.
      // Refuse to arm it and converge the live bundle before hook registration.
      if (storedGoal && isSameGoalInstance(storedGoal, session.state.goalTerminal)) {
        session.state.activeGoal = undefined;
        storedGoal = undefined;
        this.sessionManager.saveState(session.state);
      }
      if (explicitGoal && this.config.isSubAgent !== true) {
        const replaced = !!storedGoal && storedGoal.objective !== explicitGoal.objective;
        // Stamp WHEN this goal was set so the judge can anchor relative deadlines
        // ("做到3点") to the set time, not "now" — else once the clock passes the
        // deadline the judge could read "3点" as tomorrow's and never stop. A new
        // or changed objective gets a fresh stamp; re-sending the SAME objective
        // keeps the original anchor (the goal continues, the user didn't restate a
        // new deadline). User input never carries setAtMs, so we set it here.
        const resolvedSetAt = resolveGoalSetAt(explicitGoal.objective, storedGoal, Date.now());
        // A user explicitly re-starting the same objective creates a new goal
        // instance. Avoid a same-millisecond collision with its old tombstone.
        explicitGoal.setAtMs =
          session.state.goalTerminal?.objective === explicitGoal.objective &&
          session.state.goalTerminal.setAtMs === resolvedSetAt
            ? resolvedSetAt + 1
            : resolvedSetAt;
        session.state.activeGoal = explicitGoal;
        this.sessionManager.saveState(session.state);
        options?.onStream?.({
          type: "goal_set",
          objective: explicitGoal.objective,
          replaced,
        });
      }
      const normalizedGoal = explicitGoal ?? storedGoal ?? normalizeGoal(this.config.goal);
      // Snapshot the persisted goal identity owned by THIS run. Terminal
      // cleanup compares against this immutable copy so an old run cannot
      // delete a replacement goal installed while it was finishing.
      const persistedRunGoal =
        normalizedGoal && isSameGoalInstance(session.state.activeGoal, normalizedGoal)
          ? { ...normalizedGoal }
          : undefined;
      let goalHookHandler: ReturnType<typeof createGoalStopHook> | null = null;
      let latestGoalJudgeContext: GoalJudgeRuntimeContext | undefined;
      if (normalizedGoal && this.config.isSubAgent !== true) {
        goalHookHandler = createGoalStopHook({
          goal: normalizedGoal,
          llm: llmClient,
          log: logger,
          getJudgeContext: () => latestGoalJudgeContext,
          onJudgeUsage: (usage) => {
            // The provider records this request into llmClient.getUsage() and the
            // process-wide CostTracker. This separate callback feeds the session
            // cumulative cache counters and the live Goal hard-budget tracker.
            if (usage) recordCumulativeUsage(usage);
            return turnLoop.recordGoalJudgeUsage(usage);
          },
          // Clear the persisted active goal the moment the judge says it's met,
          // so a later bare send doesn't re-inherit a satisfied goal. The hook
          // calls this from inside its met branch (single source of truth for
          // "goal achieved"); engine owns the persistence side-effect.
          onMet: () => {
            if (
              persistedRunGoal &&
              isSameGoalInstance(session.state.activeGoal, persistedRunGoal)
            ) {
              session.state.activeGoal = undefined;
              this.sessionManager.saveState(session.state);
            }
          },
          // Re-read the persisted goal each turn so a mid-run 清除 (clearGoal
          // wrote state.json but this hook's frozen goal copy + the closure's
          // in-RAM session are untouched) actually stops the judge. Reads disk
          // via readActiveGoal — authoritative and independent of which session
          // instance the run closure holds.
          isGoalActive: (sid) =>
            isSameGoalInstance(this.sessionManager.readActiveGoal(sid), normalizedGoal),
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
      turnLoop = new TurnLoop(
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
          releaseClientMessageId: (clientMessageId) => {
            claimedClientMessageIds.delete(clientMessageId);
          },
          setOriginClientMessageId: (clientMessageId) => {
            toolCtx.originClientMessageId = clientMessageId;
          },
          recordCumulativeUsage,
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
          clearPersistedGoal: () => {
            if (
              persistedRunGoal &&
              isSameGoalInstance(session.state.activeGoal, persistedRunGoal)
            ) {
              session.state.activeGoal = undefined;
              this.sessionManager.saveState(session.state);
            }
            if (goalHookHandler) {
              this.hooks.unregister("on_stop", goalHookHandler);
              if (this.activeGoalHook === goalHookHandler) this.activeGoalHook = null;
            }
          },
          publishGoalJudgeContext: (context) => {
            latestGoalJudgeContext = context;
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
            this.sessionManager.saveState(session.state);
          },
        },
      );
      toolCtx.recordBilledUsage = recordExternalBilledUsage;

      // Expose this run's loop for mid-run extension (TODO 3.1). Top-level only —
      // a sub-agent's loop is its own concern and isn't user-extendable.
      if (this.config.isSubAgent !== true) this.activeTurnLoop = turnLoop;
      // Expose this run's session bundle so a mid-run clearGoal() wipes the goal
      // on the very instance this loop keeps saving (see field doc). Top-level
      // only — sub-agents don't carry user-clearable persistent goals.
      if (this.config.isSubAgent !== true) this.activeRunSession = session;

      const applyGoalTermination = (termination: GoalTerminationReason | undefined): void => {
        if (!termination || !persistedRunGoal) return;
        // Judge prompt overflow ends only this run. The objective is unfinished
        // and may be resumed after the user reduces fixed judge context, so it
        // must not get a terminal tombstone or be cleared from activeGoal.
        if (termination === "judge_prompt_too_large") return;
        // Record the terminal identity even when a newer goal has already
        // replaced it. Only clear activeGoal when it is still the run's goal.
        session.state.goalTerminal = {
          objective: persistedRunGoal.objective,
          setAtMs: persistedRunGoal.setAtMs,
          reason: termination,
          terminatedAtMs: Date.now(),
        };
        if (isSameGoalInstance(session.state.activeGoal, persistedRunGoal)) {
          session.state.activeGoal = undefined;
        }
        this.sessionManager.saveState(session.state);
        if (goalHookHandler) {
          this.hooks.unregister("on_stop", goalHookHandler);
          if (this.activeGoalHook === goalHookHandler) this.activeGoalHook = null;
        }
      };

      let result: Awaited<ReturnType<typeof turnLoop.run>>;
      let firstGoalTermination: GoalTerminationReason | undefined;
      try {
        result = await turnLoop.run(messages);
        firstGoalTermination = result.goalTermination;
        applyGoalTermination(result.goalTermination);

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
            if (aborted || firstGoalTermination) {
              // Mark injected: a synthetic notification, not the user's own input —
              // the disk reader drops it on replay so no phantom user bubble.
              // A goal termination is also a hard boundary: retain the notification
              // for recovery, but never re-enter TurnLoop (which would reset its
              // run-scoped goal budget tracker and could overwrite the first reason).
              session.transcript.appendMessage(injected.role, injected.content, { injected: true });
              result = { ...result, messages: [...result.messages, injected] };
              break;
            }
            result = await turnLoop.run([...result.messages, injected]);
            firstGoalTermination ??= result.goalTermination;
            applyGoalTermination(result.goalTermination);
          }
        }
      } finally {
        // Run-scoped: drop the GoalStopHook so a later goal-less send on this
        // long-lived engine doesn't keep blocking stops.
        if (goalHookHandler) this.hooks.unregister("on_stop", goalHookHandler);
        if (this.activeGoalHook === goalHookHandler) this.activeGoalHook = null;
        if (this.activeTurnLoop === turnLoop) this.activeTurnLoop = null;
        if (this.activeRunSession === session) this.activeRunSession = null;
        // Run-scoped too: this handler is re-registered every run(), so it must be
        // dropped here or it stacks duplicates that re-snapshot on every tool.
        fileHistoryHook.dispose();
      }
      this.lastMessages = result.messages;
      const cachedMessages = stripInjectedContextMessages(
        result.messages,
        userContextMsg,
        dynamicContextMsg,
      );
      this.compactedMessagesBySession.set(session.state.sessionId, cachedMessages);

      logger.info("engine.done", {
        sessionId: session.state.sessionId,
        reason: result.reason,
        turns: turnLoop.currentTurn,
        tokens: getRunUsage().totalTokens,
      });
      recordSessionEnd(session.state.sessionId, {
        reason: result.reason,
        turns: turnLoop.currentTurn,
        cost: getRunUsage(),
      });

      // Session-level hook: fired symmetrically with on_session_start once
      // the turn loop has resolved (completion, error, or abort). Handlers
      // are notify-only — any returned messages are dropped because the run
      // is already over and there's no next turn to inject into.
      await this.emitHook(
        "on_session_end",
        {
          sessionId: session.state.sessionId,
          reason: result.reason,
          turnCount: turnLoop.currentTurn,
        },
        options?.signal,
      );

      // Fire-and-forget memory pipeline: extract durable memories from the
      // transcript, save a session summary, and conditionally trigger
      // auto-dream consolidation. Doesn't block the Engine result.
      void this.runMemoryPipeline(
        session.transcript,
        session.state.sessionId,
        cwd,
        llmClient,
        recordExternalBilledUsage,
      );

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
          const sessionId = session.state.sessionId;
          const rawContent = (userMsgEvents[0]?.data as { content?: unknown })?.content;
          const firstUserText =
            typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent ?? "");
          void buildSessionTitle(
            auxSummaryClient,
            firstUserText,
            result.text,
            recordExternalBilledUsage,
          )
            .then((title) => {
              if (title) {
                // Persist the title so it survives a localStorage wipe / disk
                // rebuild — it used to live only in the renderer's localStorage
                // index. Read the latest persisted state at callback time and
                // merge only title; the completed run's session.state snapshot
                // may already be stale after later serial session updates.
                this.sessionManager.updateSessionState(sessionId, { title });
                onStream({
                  type: "session_title",
                  sessionId,
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
      if (session.transcript.flushFailed()) {
        const failure = session.transcript.getFlushFailure();
        logger.error("engine.transcript_persistence_failed", {
          sessionId: session.state.sessionId,
          terminalReason: result.reason,
          degraded: true,
          ...failure,
        });
      }
      session.state.turnCount = turnLoop.currentTurn;
      session.state.status = result.reason;
      // Session-cumulative (baseline + this run) for persistence...
      const usage = getRunUsage();
      session.state.tokenUsage = foldRunUsage(usageBaseline, usage);
      if (this.config.costStore) {
        session.state.costState = this.config.costStore.serialize() as Record<string, unknown>;
      }
      // runInProgress excludes another whole-state writer only on this Engine
      // instance. A different Engine using the same sessionId can still race
      // this saveState (including an old run's abort cleanup vs a replacement
      // Engine); cross-instance/process session serialization is a separate finding.
      this.sessionManager.saveState(session.state);
      runAccountingFinalized = true;

      // Hook: agent end
      await this.emitHook(
        "on_agent_end",
        {
          sessionId: session.state.sessionId,
          reason: result.reason,
          turnCount: turnLoop.currentTurn,
        },
        options?.signal,
      );

      // Emit completion
      options?.onStream?.({ type: "turn_complete", reason: result.reason });

      return {
        text: result.text,
        reason: result.reason,
        goalTermination: firstGoalTermination,
        sessionId: session.state.sessionId,
        turnCount: turnLoop.currentTurn,
        usage: {
          promptTokens: usage.totalPromptTokens,
          completionTokens: usage.totalCompletionTokens,
          totalTokens: usage.totalTokens,
          cacheReadTokens: usage.totalCacheReadTokens,
          cacheCreationTokens: usage.totalCacheCreationTokens,
        },
      };
    });
    return Promise.resolve(sessionRun).catch((err): EngineResult => {
      // The session is already persisted as active before runWithSid starts.
      // Initialization failures (client creation, MCP connection, prompt/hooks)
      // therefore need the same terminal lifecycle treatment as turn-loop errors.
      const error = formatFriendlyError(err);
      session.state.status = "model_error";
      this.sessionManager.saveState(session.state);
      session.transcript.appendError(error, { phase: "initialization" });
      logger.error("engine.run_lifecycle_failed", {
        sessionId: session.state.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      recordSessionEnd(session.state.sessionId, {
        reason: "model_error",
        turns: session.state.turnCount,
      });
      options?.onStream?.({ type: "error", error });
      options?.onStream?.({ type: "turn_complete", reason: "model_error" });

      const usage = session.state.tokenUsage;
      return {
        text: `ERROR: ${error}`,
        reason: "model_error",
        sessionId: session.state.sessionId,
        turnCount: session.state.turnCount,
        usage: {
          promptTokens: usage.promptTokens ?? 0,
          completionTokens: usage.completionTokens ?? 0,
          totalTokens: usage.totalTokens ?? 0,
          cacheReadTokens: usage.cacheReadTokens ?? 0,
          cacheCreationTokens: usage.cacheCreationTokens ?? 0,
        },
      };
    });
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
        const bundle = this.sessionManager.resume(sessionId);
        bundle.state.tokenUsage = { ...zero };
        this.sessionManager.saveState(bundle.state);
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
      const prevTools = resolveBuiltinToolNames({
        preset: prevPresetName,
        host: this.config.builtinToolHost,
      })
        .slice()
        .sort()
        .join(",");
      const nextTools = resolveBuiltinToolNames({
        preset: nextPreset.name,
        host: this.config.builtinToolHost,
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
   * persistent goal lives only in state.activeGoal and is never replayed from
   * the transcript, so after a reload of an aborted goal run the UI would
   * otherwise show nothing (the "goal 还在但页面不显示、取消不了" bug). Returns
   * undefined when the session is unknown or has no active goal.
   */
  getGoal(sessionId: string): GoalConfig | undefined {
    return this.sessionManager.readActiveGoal(sessionId);
  }

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
    // Prefer the LIVE run's bundle when it's this session: clearing its
    // in-RAM state.activeGoal is what stops the run loop from writing the goal
    // back on its next saveState. A fresh resume() copy would be cleared and
    // persisted, but the running loop's own detached bundle still holds the
    // goal and resurrects it — the stale-write-back race. Falls back to a
    // resumed copy when no run of this session is currently in flight.
    const live =
      this.activeRunSession && this.activeRunSession.state.sessionId === sessionId
        ? this.activeRunSession
        : null;
    const session = live ?? this.sessionManager.resume(sessionId);
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

  /**
   * Reset a session's workspace pointer back to its main root. If the session is
   * actively running, mutate that live SessionBundle first so the run's next
   * saveState cannot resurrect a stale worktree pointer.
   */
  releaseSessionWorkspace(sessionId: string): import("../types.js").SessionWorkspace | null {
    if (!sessionId || !this.sessionManager.exists(sessionId)) return null;
    const mainRoot =
      this.sessionManager.readCwd(sessionId) ??
      (this.activeRunSession?.state.sessionId === sessionId
        ? this.activeRunSession.state.cwd
        : undefined);
    if (!mainRoot) return null;
    const workspace: import("../types.js").SessionWorkspace = { root: mainRoot, kind: "main" };
    if (this.activeRunSession?.state.sessionId === sessionId) {
      this.activeRunSession.state.workspace = workspace;
    }
    try {
      const bundle =
        this.activeRunSession?.state.sessionId === sessionId
          ? this.activeRunSession
          : this.sessionManager.resume(sessionId);
      bundle.state.workspace = workspace;
      this.sessionManager.saveState(bundle.state);
    } catch {
      try {
        this.sessionManager.setSessionWorkspace(sessionId, workspace);
      } catch {
        return null;
      }
    }
    return workspace;
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
        const next = addCumulativeUsage(session.state, usage);
        Object.assign(session.state, next);
        this.sessionManager.saveState(session.state);
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
  private getAgentDefinitions(cwd: string): AgentDefinitionRegistry {
    const disabledAgents = this.readDisabledAgents(cwd);
    const disabledPlugins = this.readDisabledLists().disabledPlugins;
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
  private readBuiltinOverride(cwd?: string): Record<string, CapabilityOverride> | undefined {
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
  /**
   * Read the project's `localEnvironment.setupScripts` for this cwd (the raw
   * per-platform map). Used by EnterWorktree to run setup once in a freshly
   * created worktree. Returns undefined for sub-agents / no cwd (same minimal
   * surface as readShellEnv). The platform selection + run live in
   * git/worktree.ts; this only fetches the configured scripts.
   */
  readWorktreeSetupScripts(
    cwd?: string,
  ): { default?: string; macos?: string; linux?: string; windows?: string } | undefined {
    return this.runEnvironmentResolver.readWorktreeSetupScripts(cwd);
  }

  readWorktreeBranchPrefix(cwd?: string): string | undefined {
    return this.runEnvironmentResolver.readWorktreeBranchPrefix(cwd);
  }

  async resolveWorktreeSetupSandbox(cwd: string): Promise<SandboxBackend | undefined> {
    return this.runEnvironmentResolver.resolveWorktreeSetupSandbox(cwd);
  }

  readWorktreeSetupShellEnv(cwd?: string): Record<string, string> | undefined {
    return this.runEnvironmentResolver.readShellEnv(cwd);
  }

  buildToolContext(): ToolContext {
    const { disabledSkills, disabledPlugins } = this.readDisabledLists();
    const ctx: ToolContext = {
      shellEnv: this.runEnvironmentResolver.readShellEnv(this.config.cwd),
      cwd: this.config.cwd ?? process.cwd(),
      llmConfig: this.config.llm,
      modelPool: this.modelPool,
      toolRegistry: this.toolRegistry,
      askUser: this.config.askUser,
      browser: this.config.browserBridge,
      workspace: this.config.workspaceBridge,
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

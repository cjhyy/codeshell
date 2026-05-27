/**
 * Engine — the main facade that wires all components together.
 */

import type {
  Message,
  LLMConfig,
  Settings,
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
import { loadPluginHooks } from "../plugins/loadPluginHooks.js";
import { patchOrphanedToolUses } from "./patch-orphaned-tools.js";
import { runShellHook, shellHookMatches } from "../hooks/shell-runner.js";
import { ContextManager } from "../context/manager.js";
import { PromptComposer } from "../prompt/composer.js";
import { SessionManager, type SessionBundle } from "../session/session-manager.js";
import { Transcript } from "../session/transcript.js";
import { ModelFacade } from "./model-facade.js";
import type { CostStateStore } from "./cost-store.js";
import { logger, setCurrentSid, runWithSid } from "../logging/logger.js";
import { recordSessionStart, recordSessionEnd } from "../logging/session-recorder.js";
import { sanitizeContent, sanitizeTaskString } from "../logging/sanitize-messages.js";
import { TurnLoop, type TurnLoopConfig } from "./turn-loop.js";
import type { AskUserFn } from "../tool-system/builtin/ask-user.js";
import { MCPManager } from "../tool-system/mcp-manager.js";
import { SettingsManager, type SettingsScope } from "../settings/manager.js";
import { FileHistory } from "../session/file-history.js";
import type { ToolContext, SubAgentSpawner } from "../tool-system/context.js";
import {
  defaultSandboxConfig,
  resolveSandboxBackend,
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
import { capabilitiesFor } from "../llm/capabilities/index.js";
import type { ProviderKindName } from "../llm/provider-kinds.js";
import type { ContentBlock } from "../types.js";
import { MemoryOrchestrator } from "../services/memory-orchestrator.js";
import { EngineRuntime } from "./runtime.js";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

export interface EngineConfig {
  llm: LLMConfig;
  cwd?: string;
  maxTurns?: number;
  maxToolCallsPerTurn?: number;
  permissionMode?: "default" | "acceptEdits" | "dontAsk" | "bypassPermissions" | "auto" | "plan";
  preset?: AgentPresetName;
  enabledBuiltinTools?: string[];
  disabledBuiltinTools?: string[];
  customSystemPrompt?: string;
  appendSystemPrompt?: string;
  sessionStorageDir?: string;
  maxContextTokens?: number;
  approvalBackend?: ApprovalBackend;
  hooks?: EngineHookConfig[];
  askUser?: AskUserFn;
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
 * - `modelKey` set + present in pool → that model's config (over parent base).
 * - otherwise (no key, no pool, or key miss) → the parent's llm unchanged.
 * Key miss is a soft fallback, NOT an error: a stale agent definition must not
 * crash the spawn.
 */
export function resolveChildLlm(
  modelKey: string | undefined,
  pool: ModelPool | undefined,
  parentLlm: LLMConfig,
): LLMConfig {
  if (modelKey && pool?.has(modelKey)) {
    const resolved = pool.resolveLLMConfig(modelKey, parentLlm);
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
export function loadAgentDefinitionsForCwd(
  cwd: string,
  disabledAgents: string[] = [],
): AgentDefinitionRegistry {
  const home = homedir();
  return AgentDefinitionRegistry.loadFromDirs(
    [
      { dir: `${cwd}/.code-shell/agents`, source: "project" },
      { dir: `${home}/.code-shell/agents`, source: "user" },
    ],
    disabledAgents,
  );
}

const NESTED_AGENT_TOOLS = ["Agent", "AgentStatus", "AgentCancel"];

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
  private readonly preset: AgentPreset;
  private toolRegistry: ToolRegistry;
  private hooks: HookRegistry;
  private sessionManager: SessionManager;
  private mcpManager: MCPManager | undefined;
  private modelPool: ModelPool;
  /** Memoized sub-agent role registry, keyed by the cwd it was loaded from. */
  private agentDefsCache?: { cwd: string; disabledKey: string; reg: AgentDefinitionRegistry };

  /** Shared resources supplied at construction (adapter pattern — null when self-constructed). */
  readonly runtime: EngineRuntime | null;
  /** Active permission mode for this Engine instance. */
  permissionMode: NonNullable<EngineConfig["permissionMode"]>;
  /** True when permissionMode === "plan". */
  planMode: boolean;

  // Lazy SettingsManager — reused across updateConfig/readSetting so we
  // don't re-read 6+ JSON files on every /model, /login, etc. The manager
  // handles its own cache invalidation in saveUserSetting().
  private settingsManager: SettingsManager | undefined;

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
  private activePermission: PermissionClassifier | undefined;

  /** Public accessor so UI/clients can read the resolved per-model window. */
  get maxContextTokens(): number {
    return this.resolveMaxContextTokens();
  }

  private resolveMaxContextTokens(): number {
    const modelEntry = this.modelPool.get();
    return modelEntry?.maxContextTokens ?? this.config.maxContextTokens ?? 200_000;
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
      this.hooks.register(
        entry.event as HookEventName,
        async (ctx) => {
          if (!shellHookMatches(entry, ctx)) return {};
          return runShellHook(entry, ctx);
        },
        50,
        `shell:${entry.event}:${entry.command.slice(0, 32)}`,
      );
    }
  }

  constructor(private config: EngineConfig) {
    // Wire shared runtime (adapter pattern — null when self-constructing).
    this.runtime = config.runtime ?? null;

    // Instance-level permission/plan mode fields.
    this.permissionMode = config.permissionMode ?? "acceptEdits";
    this.planMode = this.permissionMode === "plan";

    this.preset = resolveAgentPreset(config.preset);
    this.toolRegistry = config.runtime?.toolRegistry ?? new ToolRegistry({
      builtinTools: resolveBuiltinToolNames({
        preset: this.preset.name,
        enabledBuiltinTools: config.enabledBuiltinTools,
        disabledBuiltinTools: config.disabledBuiltinTools,
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
      loadPluginHooks(this.hooks, this.readDisabledLists().disabledPlugins);
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
      if (settings.models?.length) {
        for (const m of settings.models) {
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
          const activeKey = (settings as { activeKey?: string }).activeKey;
          let match: (typeof settings.models)[number] | undefined;
          if (activeKey) {
            match = settings.models.find((m: any) => m.key === activeKey);
          }
          if (!match) {
            const currentModel = this.config.llm.model;
            // OpenRouter stores entries as "provider/model-name"; the top-level
            // settings.model.name is just "model-name". Match either form.
            match = settings.models.find(
              (m: any) =>
                m.model === currentModel ||
                (currentModel && m.model?.endsWith(`/${currentModel}`)),
            );
          }
          if (match) {
            const entry = this.modelPool.switch(match.key);
            this.config = {
              ...this.config,
              llm: this.modelPool.toLLMConfig(entry, this.config.llm),
            };
          }
        }
      } else if (this.config.llm.apiKey) {
        // Auto-populate pool from the configured API key when models[] is empty.
        // This lets users who only set model.apiKey (without models[]) still
        // use /model to switch between the provider's available models.
        this.autoPopulatePool(this.config.llm.apiKey, this.config.llm.baseUrl);
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
        llm: this.modelPool.toLLMConfig(entry, this.config.llm),
      };
    }
  }

  /**
   * Register a custom tool (from product adapter) into the tool registry.
   * Must be called before run().
   */
  registerCustomTool(
    definition: import("../types.js").RegisteredTool,
    executor: (args: Record<string, unknown>) => Promise<string>,
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
   * Run a task from start to finish.
   */
  async run(
    task: string,
    options?: {
      cwd?: string;
      onStream?: StreamCallback;
      signal?: AbortSignal;
      sessionId?: string;
    },
  ): Promise<EngineResult> {
    const cwd = options?.cwd ?? this.config.cwd ?? process.cwd();

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
          llm: { ...childLlm, retryMaxAttempts: 2 },
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
          maxTurns: req.maxTurns,
          maxContextTokens: this.config.maxContextTokens ?? 200_000,
          sessionStorageDir: this.config.sessionStorageDir,
          headless: this.config.headless,
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

    const sandboxConfig =
      this.config.sandbox ??
      defaultSandboxConfig(this.config.headless ? "auto" : "off");
    // A2: explicit sandbox modes (seatbelt, bwrap) must fail closed
    // per standard §S4. resolveSandboxBackend throws when an explicit
    // mode is unavailable on this host; we let it propagate. The
    // previous behavior — catching the throw inside the hot turn and
    // silently downgrading to "off" — was the leak A2 closes. The
    // `auto` mode handles its own downgrade with a one-time warning
    // inside resolveSandboxBackend; explicit modes do not.
    //
    // Backend is cached on EngineRuntime (when available) so the
    // capability probe runs once per (mode, cwd) instead of every turn.
    const sandboxBackend = this.runtime
      ? await this.runtime.resolveSandbox(sandboxConfig, cwd)
      : await resolveSandboxBackend(sandboxConfig, cwd);

    // sessionId is filled in after the session bundle is resolved below
    // (the session may be cold-started or resumed). Until then this is
    // intentionally shaped as a mutable local; we treat it as immutable
    // after the assignment.
    const toolCtx: ToolContext = {
      ...this.buildToolContext(),
      subAgentSpawner,
      agentDefinitions: this.getAgentDefinitions(cwd),
      sandbox: sandboxBackend,
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
    const userMessageContent: string | ContentBlock[] = parsedTask.hasImages
      ? [
          ...(parsedTask.text
            ? [{ type: "text" as const, text: parsedTask.text }]
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
      messages = this.compactedMessagesBySession.get(options.sessionId)
        ? [...this.compactedMessagesBySession.get(options.sessionId)!]
        : session.transcript.toMessages();
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
    const llmClientPromise = createLLMClient(this.config.llm);

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
    if (this.config.headless) investigationGuard.setSoftMode(true);
    toolExecutor.setInvestigationGuard(investigationGuard);
    toolExecutor.setTaskGuard(new TaskGuard(() => latestTodos));

    // Wire abort signal for cascading cancellation + per-Engine ToolContext
    toolExecutor.setSignal(options?.signal);
    toolExecutor.setContext(toolCtx);

    const contextManager = new ContextManager({
      maxTokens: this.resolveMaxContextTokens(),
    });
    this.lastContextManager = contextManager;

    const { disabledSkills, disabledPlugins } = this.readDisabledLists();
    const promptComposer = new PromptComposer({
      cwd,
      model: this.config.llm.model,
      preset: this.preset,
      customSystemPrompt: this.config.customSystemPrompt,
      appendSystemPrompt: this.config.appendSystemPrompt,
      disabledSkills,
      disabledPlugins,
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
      await this.mcpManager.connectAll(mcpServers);
    }

    // Parallelize slow initialization:
    //   1. createLLMClient — network handshake (started earlier)
    //   2. buildSystemPrompt — includes git status (3 execSync calls)
    //   3. buildSystemContext — reads environment context
    const allToolDefs = this.toolRegistry.getToolDefinitions();

    // In plan mode, only expose read-only tools so the model won't attempt writes
    const planModeAllowed = new Set([
      "EnterPlanMode",
      "ExitPlanMode",
      "Read",
      "Glob",
      "Grep",
      "WebSearch",
      "WebFetch",
      "AskUserQuestion",
      "Agent",
      "ToolSearch",
      "TaskCreate",
      "TaskUpdate",
      "TaskList",
      "TaskGet",
      "Bash", // Bash is included but executor filters non-read-only commands
    ]);
    const toolDefs = this.planMode
      ? allToolDefs.filter((t) => planModeAllowed.has(t.name))
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
    contextManager.setSummarizeFn(async (prompt: string) => {
      const summaryResponse = await llmClient.createMessage({
        systemPrompt: "You are a conversation summarizer. Be concise and factual.",
        messages: [{ role: "user", content: prompt }],
        tools: [],
        maxTokens: 1024,
        // Auxiliary call — no need to burn reasoning tokens. On DeepSeek V4
        // this flips thinking off (~3x faster, fewer tokens); on every other
        // OpenAI-compatible provider the field is ignored.
        thinking: "disabled",
      });
      return summaryResponse.text;
    });

    // Create components (requires resolved llmClient)
    const modelFacade = new ModelFacade(llmClient, session.transcript);

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
      const resp = await llmClient.createMessage({
        systemPrompt: sysPrompt,
        messages: [{ role: "user", content: userMsg }],
        tools: [],
        maxTokens: 256,
        recordUsage: false,
        // Auxiliary call — see contextManager.setSummarizeFn above.
        thinking: "disabled",
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
      this.config.sessionStorageDir ?? join(homedir(), ".code-shell", "sessions"),
      session.state.sessionId,
    );
    const fileHistory = FileHistory.loadFromDir(sessionDir);

    this.hooks.register(
      "on_tool_start",
      async (context) => {
        const toolName = context.data?.toolName as string;
        const args = context.data?.args as Record<string, unknown> | undefined;
        if ((toolName === "Write" || toolName === "Edit") && args?.file_path) {
          fileHistory.saveSnapshot(args.file_path as string);
        }
        return {};
      },
      100,
      "file_history_backup",
    );

    // Hook: agent start
    await this.emitHook("on_agent_start", {
      sessionId: session.state.sessionId,
      task,
      model: this.config.llm.model,
    });

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
        ctxOverheadStore: {
          get: (s) => this.ctxOverheadBySid.get(s) ?? 0,
          set: (s, n) => {
            this.ctxOverheadBySid.set(s, n);
          },
        },
      },
      {
        maxTurns: this.config.maxTurns ?? 100,
        maxToolCallsPerTurn: this.config.maxToolCallsPerTurn ?? 10,
        onStream: options?.onStream,
        signal: options?.signal,
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

    const result = await turnLoop.run(messages);
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
  private async runMemoryPipeline(
    transcript: import("../session/transcript.js").Transcript,
    sessionId: string,
    cwd: string,
    llmClient: Awaited<ReturnType<typeof createLLMClient>>,
  ): Promise<void> {
    try {
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
            thinking: "disabled",
          });
          return resp.text;
        },
        runDream: async ({ systemPrompt, userPrompt, projectDir }) =>
          this.runDreamLoop({ systemPrompt, userPrompt, projectDir, llmClient, sessionId }),
        projectDir: cwd,
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
    const MAX_TURNS = 8;
    const MAX_WRITES = 10;
    const MEMORY_TOOL_NAMES = ["MemoryList", "MemoryRead", "MemorySave", "MemoryDelete"];

    const memoryTools = MEMORY_TOOL_NAMES
      .map((n) => this.toolRegistry.getTool(n))
      .filter((t): t is NonNullable<typeof t> => t != null);
    if (memoryTools.length < MEMORY_TOOL_NAMES.length) {
      logger.warn("memory.auto_dream_missing_tools", {
        sessionId: opts.sessionId,
        found: memoryTools.map((t) => t.name),
      });
      return false;
    }

    // Strip RegisteredTool down to the shape createMessage expects.
    const toolDefs = memoryTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    const toolCtx: ToolContext = {
      ...this.buildToolContext(),
      cwd: opts.projectDir ?? process.cwd(),
    };

    const messages: Message[] = [{ role: "user", content: opts.userPrompt }];
    let writeBudget = MAX_WRITES;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const resp = await opts.llmClient.createMessage({
        systemPrompt: opts.systemPrompt,
        messages,
        tools: toolDefs,
        maxTokens: 2048,
        recordUsage: false,
        thinking: "disabled",
      });

      if (resp.toolCalls.length === 0) {
        logger.info("memory.auto_dream_finished", {
          sessionId: opts.sessionId,
          turn,
          finalText: resp.text.slice(0, 500),
        });
        return true;
      }

      // Echo the assistant turn back into the conversation so subsequent
      // turns see the tool_use ids they need to reference.
      const assistantContent: import("../types.js").ContentBlock[] = [];
      if (resp.text) assistantContent.push({ type: "text", text: resp.text });
      for (const tc of resp.toolCalls) {
        assistantContent.push({
          type: "tool_use",
          id: tc.id,
          name: tc.toolName,
          input: tc.args,
        });
      }
      messages.push({ role: "assistant", content: assistantContent });

      // Dispatch every tool call requested in this turn.
      const toolResults: import("../types.js").ContentBlock[] = [];
      for (const tc of resp.toolCalls) {
        const result = await this.dispatchDreamTool(tc, toolCtx, () => {
          if (writeBudget <= 0) return false;
          writeBudget--;
          return true;
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tc.id,
          content: result,
        });
      }
      messages.push({ role: "user", content: toolResults });
    }

    logger.warn("memory.auto_dream_hit_turn_cap", {
      sessionId: opts.sessionId,
      maxTurns: MAX_TURNS,
    });
    return true;
  }

  /**
   * Execute one memory tool call inside the dream loop. Enforces the two
   * dream-loop invariants the prompt also states:
   *   - Only the 4 memory tools are dispatchable.
   *   - Save/Delete in "user" scope is refused (returned as a tool error)
   *     because dream runs without an interactive permission backend.
   */
  private async dispatchDreamTool(
    tc: import("../types.js").ToolCall,
    ctx: import("../tool-system/context.js").ToolContext,
    consumeWriteBudget: () => boolean,
  ): Promise<string> {
    const allowed = new Set(["MemoryList", "MemoryRead", "MemorySave", "MemoryDelete"]);
    if (!allowed.has(tc.toolName)) {
      return `Error: tool "${tc.toolName}" is not available in the dream loop`;
    }

    const isWrite = tc.toolName === "MemorySave" || tc.toolName === "MemoryDelete";
    if (isWrite) {
      const scope = tc.args?.scope;
      if (scope !== "dream") {
        return (
          `Error: dream loop may only write to scope "dream", got "${scope}". ` +
          `User-scope changes require interactive permission, which is not available here.`
        );
      }
      if (!consumeWriteBudget()) {
        return "Error: dream write budget exhausted — stop calling write tools and summarize instead.";
      }
    }

    try {
      const result = await this.toolRegistry.executeTool(tc.toolName, tc.args, { ctx });
      if (result.isError) return result.error ?? `Error executing ${tc.toolName}`;
      return result.result ?? "";
    } catch (err) {
      return `Error executing ${tc.toolName}: ${(err as Error).message}`;
    }
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
    const nextLlm = this.modelPool.toLLMConfig(entry, this.config.llm);
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
      const dir = join(homedir(), ".code-shell");
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
   * Inject context into a session's transcript without triggering a LLM turn.
   * The injected content appears as an assistant message so the LLM can see it
   * in subsequent conversations. The transcript auto-flushes to disk.
   *
   * Also updates the in-memory compacted message cache so the next
   * engine.run() call for this session picks up the injected content
   * instead of a stale snapshot from the previous run.
   */
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
    const { estimateTokens } = require("../context/compaction.js");
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
   * Sub-agent role registry for the given cwd, memoized per-cwd so the
   * directory is read once rather than every turn. A new cwd (e.g. via
   * run({ cwd })) reloads.
   */
  private getAgentDefinitions(cwd: string): AgentDefinitionRegistry {
    const disabledAgents = this.readDisabledAgents();
    const disabledKey = disabledAgents.slice().sort().join(" ");
    if (
      this.agentDefsCache?.cwd !== cwd ||
      this.agentDefsCache.disabledKey !== disabledKey
    ) {
      this.agentDefsCache = {
        cwd,
        disabledKey,
        reg: loadAgentDefinitionsForCwd(cwd, disabledAgents),
      };
    }
    return this.agentDefsCache.reg;
  }

  /**
   * Read settings.disabledAgents. Unlike disabledSkills, sub-agents do
   * NOT skip this — a disabled role must stay invisible everywhere.
   */
  private readDisabledAgents(): string[] {
    try {
      const settings = this.getSettingsManager().get() as {
        disabledAgents?: string[];
      };
      return Array.isArray(settings.disabledAgents) ? settings.disabledAgents : [];
    } catch {
      return [];
    }
  }

  /**
   * Build a base ToolContext for this Engine. Used by run() (which then
   * overlays turn-specific fields like sandbox and subAgentSpawner) and
   * by tests that want a ToolContext without a full run() cycle.
   */
  buildToolContext(): ToolContext {
    const { disabledSkills, disabledPlugins } = this.readDisabledLists();
    return {
      cwd: this.config.cwd ?? process.cwd(),
      llmConfig: this.config.llm,
      modelPool: this.modelPool,
      toolRegistry: this.toolRegistry,
      askUser: this.config.askUser,
      isSubAgent: this.config.isSubAgent === true,
      hooks: this.hooks,
      planMode: this.planMode,
      engine: this,
      disabledSkills,
      disabledPlugins,
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
  } {
    if (this.config.isSubAgent === true) {
      return { disabledSkills: [], disabledPlugins: [] };
    }
    try {
      const settings = this.getSettingsManager().get() as {
        disabledSkills?: string[];
        disabledPlugins?: string[];
      };
      return {
        disabledSkills: settings.disabledSkills ?? [],
        disabledPlugins: settings.disabledPlugins ?? [],
      };
    } catch {
      return { disabledSkills: [], disabledPlugins: [] };
    }
  }
}

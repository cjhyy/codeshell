/**
 * Engine — the main facade that wires all components together.
 */

import type {
  Message,
  LLMConfig,
  Settings,
  StreamCallback,
  TerminalReason,
  TokenUsage,
} from "../types.js";
import { createLLMClient } from "../llm/client-factory.js";
import { ToolRegistry } from "../tool-system/registry.js";
import { ToolExecutor } from "../tool-system/executor.js";
import { InvestigationGuard } from "../tool-system/investigation-guard.js";
import {
  PermissionClassifier,
  HeadlessApprovalBackend,
  AutoApprovalBackend,
  InteractiveApprovalBackend,
  type ApprovalBackend,
} from "../tool-system/permission.js";
import { HookRegistry } from "../hooks/registry.js";
import type { HookEventName } from "../hooks/events.js";
import type { HookHandler } from "../hooks/registry.js";
import { ContextManager } from "../context/manager.js";
import { PromptComposer } from "../prompt/composer.js";
import { SessionManager, type SessionBundle } from "../session/session-manager.js";
import { Transcript } from "../session/transcript.js";
import { ModelFacade } from "./model-facade.js";
import type { CostStateStore } from "./cost-store.js";
import { logger } from "../logging/logger.js";
import { recordSessionStart, recordSessionEnd } from "../logging/session-recorder.js";
import { TurnLoop, type TurnLoopConfig } from "./turn-loop.js";
import type { AskUserFn } from "../tool-system/builtin/ask-user.js";
import { MCPManager } from "../tool-system/mcp-manager.js";
import { isInPlanMode } from "../tool-system/builtin/plan.js";
import { SettingsManager } from "../settings/manager.js";
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
import { ProviderCatalog } from "../llm/provider-catalog.js";
import { defaultCacheDir } from "../llm/model-cache.js";
import {
  detectProviderFromApiKey,
  buildModelPool,
} from "../cli/onboarding.js";
import { detectPastedNoise } from "../utils/task-sanitizer.js";
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

export class Engine {
  private readonly preset: AgentPreset;
  private toolRegistry: ToolRegistry;
  private hooks: HookRegistry;
  private sessionManager: SessionManager;
  private mcpManager: MCPManager | undefined;
  private modelPool: ModelPool;

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
  private activePermission: PermissionClassifier | undefined;

  /** Public accessor so UI/clients can read the resolved per-model window. */
  get maxContextTokens(): number {
    return this.resolveMaxContextTokens();
  }

  private resolveMaxContextTokens(): number {
    const modelEntry = this.modelPool.get();
    return modelEntry?.maxContextTokens ?? this.config.maxContextTokens ?? 200_000;
  }

  constructor(private config: EngineConfig) {
    this.preset = resolveAgentPreset(config.preset);
    this.toolRegistry = new ToolRegistry({
      builtinTools: resolveBuiltinToolNames({
        preset: this.preset.name,
        enabledBuiltinTools: config.enabledBuiltinTools,
        disabledBuiltinTools: config.disabledBuiltinTools,
      }),
    });
    this.hooks = new HookRegistry();
    for (const hook of config.hooks ?? []) {
      this.hooks.register(hook.event, hook.handler, hook.priority, hook.name);
    }
    this.sessionManager = new SessionManager(config.sessionStorageDir);

    // Initialize model pool from settings
    this.modelPool = new ModelPool();
    this.populateModelPoolFromSettings();
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
    this.populateModelPoolFromSettings();
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
    // Switch to the provider's default model. buildModelPool emits keys in
    // `<provider>-<model-id>` form (deriveModelPoolKey), so the default
    // key matches the first entry whose `model` field equals defaultModel.
    const defaultEntry = provider.defaultModel
      ? entries.find((e) => e.model === provider.defaultModel)
      : entries[0];
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
      onStream?: StreamCallback;
      signal?: AbortSignal;
      sessionId?: string;
    },
  ): Promise<EngineResult> {
    const cwd = this.config.cwd ?? process.cwd();

    const noise = detectPastedNoise(task);
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
        const child = new Engine({
          llm: { ...this.config.llm, retryMaxAttempts: 2 },
          cwd,
          permissionMode: this.config.permissionMode,
          preset: this.preset.name,
          enabledBuiltinTools: this.config.enabledBuiltinTools,
          disabledBuiltinTools: this.config.disabledBuiltinTools,
          customSystemPrompt: this.config.customSystemPrompt,
          appendSystemPrompt: this.config.appendSystemPrompt,
          maxTurns: req.maxTurns,
          maxContextTokens: this.config.maxContextTokens ?? 200_000,
          sessionStorageDir: this.config.sessionStorageDir,
          headless: this.config.headless,
          sandbox: this.config.sandbox,
        });
        const childStream: StreamCallback | undefined = options?.onStream
          ? (event) => options.onStream!({ ...event, agentId: req.agentId } as typeof event)
          : undefined;
        const result = await child.run(req.prompt, { signal: req.signal, onStream: childStream });
        return result.text;
      },
    };

    const sandboxConfig =
      this.config.sandbox ??
      defaultSandboxConfig(this.config.headless ? "auto" : "off");
    // resolveSandboxBackend throws on an explicit but unavailable mode
    // (e.g. mode=seatbelt on Linux). That fast-fail is right at startup,
    // but here we're inside a hot turn — a misconfig shouldn't kill the
    // turn, just downgrade. Fall back to "off" with a one-shot warning.
    let sandboxBackend;
    try {
      sandboxBackend = await resolveSandboxBackend(sandboxConfig, cwd);
    } catch (err) {
      logger.warn("engine.sandbox_resolve_failed", {
        mode: sandboxConfig.mode,
        error: (err as Error).message,
      });
      sandboxBackend = await resolveSandboxBackend(
        { ...sandboxConfig, mode: "off" },
        cwd,
      );
    }

    const toolCtx: ToolContext = {
      cwd,
      llmConfig: this.config.llm,
      modelPool: this.modelPool,
      toolRegistry: this.toolRegistry,
      askUser: this.config.askUser,
      subAgentSpawner,
      sandbox: sandboxBackend,
    };

    logger.info("engine.run", {
      task: task.slice(0, 200),
      cwd,
      model: this.config.llm.model,
      preset: this.preset.name,
    });

    // Create or resume session
    let session: SessionBundle;
    let messages: Message[];

    if (options?.sessionId) {
      session = this.sessionManager.resume(options.sessionId);
      messages = this.compactedMessagesBySession.get(options.sessionId)
        ? [...this.compactedMessagesBySession.get(options.sessionId)!]
        : session.transcript.toMessages();
      // Restore cost state from previous session, if the caller injected a store
      if (session.state.costState && this.config.costStore) {
        this.config.costStore.restore(session.state.costState);
      }
      // Append new user message
      const userMsg: Message = { role: "user", content: task };
      messages.push(userMsg);
      session.transcript.appendMessage("user", task);
      // Flush "active" status to disk immediately. resume() set it in memory
      // (session-manager.ts), but without this write the on-disk state.json
      // still shows the previous run's terminal reason — so any external
      // observer (another CLI process, /sid, the session list) would think
      // the session is still errored/aborted while we're actually running.
      this.sessionManager.saveState(session.state);
    } else {
      session = this.sessionManager.create(cwd, this.config.llm.model, this.config.llm.provider);
      messages = [{ role: "user", content: task }];
      session.transcript.appendMessage("user", task);
      // Save first user message as session summary
      session.state.summary = task.slice(0, 80).replace(/\n/g, " ");
      this.sessionManager.saveState(session.state);
    }

    // Stamp the resolved session id onto the process-wide logger so every
    // subsequent log line — engine, tool exec, MCP, context manager,
    // protocol — is filterable by `sid` in ~/.code-shell/logs/.
    logger.setSid(session.state.sessionId);

    recordSessionStart(session.state.sessionId, {
      task,
      cwd,
      model: this.config.llm.model,
      provider: this.config.llm.provider,
      permissionMode: this.config.permissionMode ?? "acceptEdits",
      resumed: !!options?.sessionId,
    });

    // Rough token estimate of the full prompt so the UI's ctx bar isn't 0%
    // on resume. The authoritative count comes from `usage.promptTokens` after
    // the first LLM response — this is just a display-friendly approximation
    // so the user sees a meaningful progress bar from the first frame.
    const roughPromptTokens = messages.reduce((sum, m) => {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return sum + Math.ceil(text.length / 4);
    }, 0);

    // Tell the client the sid *now* instead of waiting for run() to resolve.
    // The user wants `/sid` to work mid-turn; without this, the client only
    // learns the sid when the run completes.
    options?.onStream?.({
      type: "session_started",
      sessionId: session.state.sessionId,
      promptTokens: roughPromptTokens,
    });

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

    // Wire abort signal for cascading cancellation + per-Engine ToolContext
    toolExecutor.setSignal(options?.signal);
    toolExecutor.setContext(toolCtx);

    const contextManager = new ContextManager({
      maxTokens: this.resolveMaxContextTokens(),
    });
    this.lastContextManager = contextManager;

    const promptComposer = new PromptComposer({
      cwd,
      model: this.config.llm.model,
      preset: this.preset,
      customSystemPrompt: this.config.customSystemPrompt,
      appendSystemPrompt: this.config.appendSystemPrompt,
    });

    // Connect MCP servers (if configured and not already connected)
    const mcpServers = this.config.mcpServers ?? {};
    if (Object.keys(mcpServers).length > 0 && !this.mcpManager) {
      this.mcpManager = new MCPManager(this.toolRegistry);
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
    const toolDefs = isInPlanMode()
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
    await this.hooks.emit("on_agent_start", {
      sessionId: session.state.sessionId,
      task,
      model: this.config.llm.model,
    });

    // Surface compaction events to the UI so the user knows when context was trimmed.
    contextManager.setOnCompact((info) => {
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
    await this.hooks.emit("on_agent_end", {
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
      this.settingsManager = new SettingsManager(this.config.cwd);
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

    if (mode === "acceptEdits" || mode === "bypassPermissions") {
      rules.push({ tool: "Write", decision: "allow" });
      rules.push({ tool: "Edit", decision: "allow" });
    }
    if (mode === "bypassPermissions") {
      rules.push({ tool: "Bash", decision: "allow" });
    }

    try {
      const settingsManager = new SettingsManager(cwd);
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
      backend = new HeadlessApprovalBackend(
        mode === "bypassPermissions" ? "approve-all" : mode === "dontAsk" ? "deny-all" : "deny-all",
      );
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
    if (this.activePermission) {
      const cwd = this.config.cwd ?? process.cwd();
      const { rules, backend } = this.buildPermissionConfig(mode, cwd);
      this.activePermission.reconfigure(mode, backend, rules);
    }
  }

  getPermissionMode(): NonNullable<EngineConfig["permissionMode"]> {
    return this.config.permissionMode ?? "acceptEdits";
  }
}

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
import { TurnLoop, type TurnLoopConfig } from "./turn-loop.js";
import type { AskUserFn } from "../tool-system/builtin/ask-user.js";
import { MCPManager } from "../tool-system/mcp-manager.js";
import { isInPlanMode } from "../tool-system/builtin/plan.js";
import { SettingsManager } from "../settings/manager.js";
import { FileHistory } from "../session/file-history.js";
import type { ToolContext, SubAgentSpawner } from "../tool-system/context.js";
import {
  resolveAgentPreset,
  resolveBuiltinToolNames,
  type AgentPreset,
  type AgentPresetName,
} from "../preset/index.js";
import { ModelPool, type ModelEntry } from "../llm/model-pool.js";
import { join } from "node:path";
import { homedir } from "node:os";

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
    try {
      const sm = new SettingsManager(config.cwd);
      const settings = sm.get();
      if (settings.models?.length) {
        for (const m of settings.models) {
          this.modelPool.register({
            key: m.key,
            label: m.label,
            provider: m.provider,
            model: m.model,
            baseUrl: m.baseUrl,
            apiKey: m.apiKey,
            maxOutputTokens: m.maxOutputTokens,
          });
        }
        // Set active to the current config model
        const currentModel = config.llm.model;
        const match = settings.models.find((m: any) => m.model === currentModel);
        if (match) this.modelPool.switch(match.key);
      }
    } catch {
      // Settings not available — pool stays empty
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
        });
        const childStream: StreamCallback | undefined = options?.onStream
          ? (event) => options.onStream!({ ...event, agentId: req.agentId } as typeof event)
          : undefined;
        const result = await child.run(req.prompt, { signal: req.signal, onStream: childStream });
        return result.text;
      },
    };

    const toolCtx: ToolContext = {
      cwd,
      llmConfig: this.config.llm,
      modelPool: this.modelPool,
      toolRegistry: this.toolRegistry,
      askUser: this.config.askUser,
      subAgentSpawner,
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

    // Wire abort signal for cascading cancellation + per-Engine ToolContext
    toolExecutor.setSignal(options?.signal);
    toolExecutor.setContext(toolCtx);

    const contextManager = new ContextManager({
      maxTokens: this.config.maxContextTokens ?? 200_000,
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

    // Wire summarize for tool use summaries (uses lightweight call)
    modelFacade.summarize = async (sysPrompt: string, userMsg: string) => {
      const resp = await llmClient.createMessage({
        systemPrompt: sysPrompt,
        messages: [{ role: "user", content: userMsg }],
        tools: [],
        maxTokens: 256,
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

    // Update session state
    session.state.turnCount = turnLoop.currentTurn;
    session.state.status = result.reason === "completed" ? "completed" : "errored";
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
   */
  switchModel(key: string): ModelEntry {
    const entry = this.modelPool.switch(key);
    // Update LLM config so the next run() creates the right client
    this.config = {
      ...this.config,
      llm: this.modelPool.toLLMConfig(entry, this.config.llm),
    };
    return entry;
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
   */
  injectContext(sessionId: string, content: string): void {
    const session = this.sessionManager.resume(sessionId);
    session.transcript.appendMessage("assistant", content);
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

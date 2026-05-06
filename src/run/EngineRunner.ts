/**
 * EngineRunner — bridges a RunSnapshot into an Engine.run() call.
 *
 * Responsibilities:
 *   - Prepare EngineConfig from run snapshot
 *   - Start or resume a session
 *   - Inject run-aware approval backend and askUser adapter
 *   - Forward stream events to RunManager
 *   - Return execution result (does NOT manage run state transitions)
 */

import { Engine, type EngineConfig, type EngineHookConfig, type EngineResult } from "../engine/engine.js";
import type { LLMConfig, StreamCallback, RegisteredTool } from "../types.js";
import type { RunSnapshot, RunExecutionContext, RunExecutionResult } from "./types.js";
import {
  RunApprovalBackend,
  createRunAskUserFn,
  type RunLifecycleHooks,
} from "./RunApprovalBackend.js";

// ─── RunExecutionHandle ─────────────────────────────────────────

/**
 * Handles returned from execute() to allow RunManager to resolve
 * pending approvals and user input while Engine is suspended.
 */
export interface RunExecutionHandle {
  /** Resolve a pending tool approval. Returns false if nothing was pending. */
  resolveApproval: (approved: boolean, reason?: string) => boolean;
  /** Resolve a pending user input request. Returns false if nothing was pending. */
  resolveInput: (answer: string) => boolean;
  /** Check if there's a pending approval. */
  hasPendingApproval: () => boolean;
  /** Check if there's a pending input request. */
  hasPendingInput: () => boolean;
}

// ─── RunExecutor interface ──────────────────────────────────────

/**
 * The contract for executing a Run. RunManager delegates to this interface.
 *
 * EngineRunner is the built-in implementation (calls CodeShell's LLM Engine).
 * External services can implement this to plug in any execution backend:
 *   - CI/CD pipeline runners
 *   - ETL orchestrators
 *   - Multi-agent coordinators
 *   - Custom API call chains
 */
export interface RunExecutor {
  execute(
    run: RunSnapshot,
    context: RunExecutionContext,
    lifecycleHooks?: RunLifecycleHooks,
    onHandleReady?: (handle: RunExecutionHandle) => void,
  ): Promise<{ result: RunExecutionResult; handle: RunExecutionHandle }>;
}

// ─── CustomToolEntry ────────────────────────────────────────────

export interface CustomToolEntry {
  definition: RegisteredTool;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

// ─── EngineRunnerConfig ─────────────────────────────────────────

export interface EngineRunnerConfig {
  llm: LLMConfig;
  maxTurns?: number;
  maxContextTokens?: number;
  sessionStorageDir?: string;
  permissionMode?: EngineConfig["permissionMode"];
  enabledBuiltinTools?: string[];
  disabledBuiltinTools?: string[];
  customSystemPrompt?: string;
  appendSystemPrompt?: string;
  mcpServers?: EngineConfig["mcpServers"];
  /** Custom tools registered by the product adapter. */
  customTools?: CustomToolEntry[];
  /** Hooks registered into each Engine instance before run execution. */
  hooks?: EngineHookConfig[];
}

// ─── EngineRunner (built-in RunExecutor) ────────────────────────

export class EngineRunner implements RunExecutor {
  constructor(private readonly config: EngineRunnerConfig) {}

  async execute(
    run: RunSnapshot,
    context: RunExecutionContext,
    lifecycleHooks?: RunLifecycleHooks,
    onHandleReady?: (handle: RunExecutionHandle) => void,
  ): Promise<{ result: RunExecutionResult; handle: RunExecutionHandle }> {
    // Create run-aware approval backend
    const approvalBackend = new RunApprovalBackend();

    // Create run-aware askUser adapter
    let resolveInputFn: (answer: string) => boolean = () => false;
    let hasPendingInputFn: () => boolean = () => false;
    let askUserFn: ((question: string) => Promise<string>) | undefined;

    if (lifecycleHooks) {
      approvalBackend.setHooks(lifecycleHooks);
      const askAdapter = createRunAskUserFn(lifecycleHooks);
      askUserFn = askAdapter.askUserFn;
      resolveInputFn = askAdapter.resolveInput;
      hasPendingInputFn = askAdapter.hasPendingInput;
    }

    const handle: RunExecutionHandle = {
      resolveApproval: (approved, reason) =>
        approvalBackend.resolveApproval(
          approved ? { approved: true } : { approved: false, reason },
        ),
      resolveInput: resolveInputFn,
      hasPendingApproval: () => approvalBackend.hasPendingApproval(),
      hasPendingInput: hasPendingInputFn,
    };

    // Expose handle immediately so RunManager can resolve approvals/input
    // while Engine is suspended
    onHandleReady?.(handle);

    const engineConfig: EngineConfig = {
      llm: this.config.llm,
      cwd: run.cwd,
      maxTurns: this.config.maxTurns ?? 30,
      maxContextTokens: this.config.maxContextTokens ?? 200_000,
      permissionMode: this.config.permissionMode ?? "acceptEdits",
      preset: run.preset,
      enabledBuiltinTools: this.config.enabledBuiltinTools,
      disabledBuiltinTools: this.config.disabledBuiltinTools,
      customSystemPrompt: this.config.customSystemPrompt,
      appendSystemPrompt: this.config.appendSystemPrompt,
      sessionStorageDir: this.config.sessionStorageDir,
      mcpServers: this.config.mcpServers,
      hooks: this.config.hooks,
      approvalBackend,
      askUser: askUserFn,
      ...context.engineConfigOverrides,
    };

    const engine = new Engine(engineConfig);

    // Register custom tools from product adapter
    if (this.config.customTools?.length) {
      for (const ct of this.config.customTools) {
        engine.registerCustomTool(ct.definition, ct.execute);
      }
    }

    const onStream: StreamCallback | undefined = context.onStream
      ? async (event) => { await context.onStream!(event); }
      : undefined;

    const result: EngineResult = await engine.run(run.objective, {
      onStream,
      signal: context.signal,
      sessionId: run.sessionId ?? undefined,
    });

    return {
      result: {
        text: result.text,
        reason: result.reason,
        sessionId: result.sessionId,
        turnCount: result.turnCount,
      },
      handle,
    };
  }
}

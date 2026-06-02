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

import { Engine, type EngineConfig, type EngineHookConfig } from "../engine/engine.js";
import type { ClientDefaults, LLMConfig, RegisteredTool } from "../types.js";
import type { RunSnapshot, RunExecutionContext, RunExecutionResult } from "./types.js";
import {
  RunApprovalBackend,
  createRunAskUserFn,
  type RunLifecycleHooks,
} from "./RunApprovalBackend.js";
import { createInProcessClient } from "../protocol/helpers.js";
import type { ApprovalBackend } from "../tool-system/permission.js";

/** Unattended runs (those with an injected approval backend) run headless so
 *  the in-process AgentServer does not wire an interactive askUser. Exported
 *  for unit testing the decision rule. */
export function buildHeadlessFlag(
  override: ApprovalBackend | undefined,
): boolean {
  return override !== undefined;
}

/** Run-metadata `source` value tagging a run as unattended automation
 *  (set by the automation host; read here to decide prompt/headless behavior). */
export const AUTOMATION_RUN_SOURCE = "automation";

/** Appended to the system prompt for unattended automation runs so the model
 *  knows it IS the automation and must not ask the user or offer to schedule
 *  automation. English by repo convention; the model answers in the user's
 *  language regardless. */
export const AUTOMATION_PROMPT_NOTE =
  "This is an unattended, scheduled automation run. No human is watching, and " +
  "AskUserQuestion will not reach anyone. You ARE the automation — do not ask " +
  "the user questions and do not offer to set up or schedule automation. " +
  "Produce the requested output directly; when uncertain, state your assumption " +
  "and proceed." +
  " When finished, call UpdateAutomationMemory exactly once with a concise " +
  "summary of this run's key findings/state for the next run.";

/** Compose the run's appendSystemPrompt: prepend the automation note when the
 *  run is tagged source "automation", preserving any host-provided append. */
export function buildAppendSystemPrompt(
  hostAppend: string | undefined,
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  if (metadata?.source !== AUTOMATION_RUN_SOURCE) return hostAppend;
  return hostAppend ? `${AUTOMATION_PROMPT_NOTE}\n\n${hostAppend}` : AUTOMATION_PROMPT_NOTE;
}

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
  /** Cross-model runtime knobs (temperature/timeout/imageDetail). */
  clientDefaults?: ClientDefaults;
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
  /**
   * Override the approval backend. When set, the run uses THIS backend instead
   * of the interactive run-aware RunApprovalBackend — used by unattended hosts
   * (e.g. automation/cron) that must auto-decide without a UI, e.g. a
   * HeadlessApprovalBackend("approve-read-only"). When unset, the interactive
   * run-aware backend is used (default REPL/desktop behavior).
   */
  approvalBackend?: ApprovalBackend;
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
    // Run-aware approval backend (interactive: suspends the run and waits for
    // RunManager to resolve via the handle). Always constructed so the handle
    // stays well-formed, but only wired into the engine when no override is set.
    const runApprovalBackend = new RunApprovalBackend();

    // Unattended override: a host (automation/cron) can inject a backend that
    // auto-decides (e.g. approve-read-only). When set, the engine uses it and
    // the interactive resolve path is inert (no UI to resolve approvals).
    const override = this.config.approvalBackend;
    const engineApprovalBackend = override ?? runApprovalBackend;

    // Create run-aware askUser adapter
    let resolveInputFn: (answer: string) => boolean = () => false;
    let hasPendingInputFn: () => boolean = () => false;
    let askUserFn: ((question: string) => Promise<string>) | undefined;

    if (lifecycleHooks && !override) {
      runApprovalBackend.setHooks(lifecycleHooks);
      const askAdapter = createRunAskUserFn(lifecycleHooks);
      askUserFn = askAdapter.askUserFn;
      resolveInputFn = askAdapter.resolveInput;
      hasPendingInputFn = askAdapter.hasPendingInput;
    }

    const handle: RunExecutionHandle = {
      resolveApproval: (approved, reason) =>
        runApprovalBackend.resolveApproval(
          approved ? { approved: true } : { approved: false, reason },
        ),
      resolveInput: resolveInputFn,
      hasPendingApproval: () => runApprovalBackend.hasPendingApproval(),
      hasPendingInput: hasPendingInputFn,
    };

    // Expose handle immediately so RunManager can resolve approvals/input
    // while Engine is suspended
    onHandleReady?.(handle);

    const engineConfig: EngineConfig = {
      llm: this.config.llm,
      clientDefaults: this.config.clientDefaults,
      cwd: run.cwd,
      maxTurns: this.config.maxTurns ?? 30,
      maxContextTokens: this.config.maxContextTokens ?? 200_000,
      permissionMode: this.config.permissionMode ?? "acceptEdits",
      headless: buildHeadlessFlag(override),
      preset: run.preset,
      enabledBuiltinTools: this.config.enabledBuiltinTools,
      disabledBuiltinTools: this.config.disabledBuiltinTools,
      customSystemPrompt: this.config.customSystemPrompt,
      // NOTE: callers must not pass appendSystemPrompt in engineConfigOverrides
      // below, or it will clobber this composed (automation note + host) value.
      appendSystemPrompt: buildAppendSystemPrompt(this.config.appendSystemPrompt, run.metadata),
      sessionStorageDir: this.config.sessionStorageDir,
      mcpServers: this.config.mcpServers,
      hooks: this.config.hooks,
      approvalBackend: engineApprovalBackend,
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

    // Wrap the engine in an in-process AgentServer + AgentClient pair so
    // the run path goes through the same protocol surface as REPL and
    // headless CLI. Side effects unique to the server (TaskManager
    // stream subscription, status notifications, in-process running
    // lock) now apply to RunManager-launched runs too.
    //
    // Approval flow stays on the engineConfig.approvalBackend path that
    // RunManager already wired — we don't subscribe client.onApprovalRequest
    // because RunApprovalBackend intercepts approvals inside the engine
    // before they reach the server's interactive-approval hook.
    const { client, close } = createInProcessClient(engine, {
      onStream: context.onStream,
    });

    // External AbortSignal → client.cancel. The signal is owned by
    // RunManager (queue cancel, manual cancel); when it aborts we ask
    // the server to stop the run, which aborts the underlying engine.run.
    const onAbort = () => {
      client.cancel().catch(() => {
        // best-effort — server may already have torn down
      });
    };
    if (context.signal) {
      if (context.signal.aborted) {
        onAbort();
      } else {
        context.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    try {
      const result = await client.run(run.objective, {
        cwd: run.cwd,
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
    } finally {
      if (context.signal) {
        context.signal.removeEventListener("abort", onAbort);
      }
      close();
    }
  }
}

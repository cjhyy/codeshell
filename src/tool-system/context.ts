/**
 * ToolContext — runtime services injected into every tool execution.
 *
 * Replaces the legacy module-level singletons (`setAskUserFn`,
 * `setArenaLLMConfig`, `setSubAgentConfig`, `setToolSearchRegistry`).
 *
 * Each Engine instance builds its own ToolContext when run() starts and
 * passes it through ToolExecutor → ToolRegistry → executor function.
 * That makes concurrent Engine instances safe: tools never see another
 * Engine's askUser handler or LLM credentials.
 *
 * Tools that don't need any context (Read/Write/Bash/...) just ignore
 * the second argument; the type is purely additive.
 */
import type { LLMConfig, StreamCallback } from "../types.js";
import type { ModelPool } from "../llm/model-pool.js";
import type { ToolRegistry } from "./registry.js";
import type { AgentPresetName } from "../preset/index.js";

/** Function the host UI / server uses to ask the user a question. */
export type AskUserFn = (question: string) => Promise<string>;

/** Spawn a sub-agent. Returns the produced text or throws. */
export interface SubAgentSpawnRequest {
  agentId: string;
  description: string;
  prompt: string;
  maxTurns: number;
  signal: AbortSignal;
}

export interface SubAgentSpawner {
  /** Run a sub-agent synchronously and return its text output. */
  spawn(req: SubAgentSpawnRequest): Promise<string>;
  /** Stream callback to forward sub-agent events back to the parent UI. */
  parentStream?: StreamCallback;
  /** Static config used to describe what the spawned engine looks like. */
  describe(): {
    cwd: string;
    preset?: AgentPresetName;
    permissionMode: string;
  };
}

/**
 * The full context object handed to every tool invocation.
 *
 * Optional fields are filled in by Engine.run(); some headless paths may
 * leave them undefined (e.g. running without UI → no askUser).
 */
export interface ToolContext {
  /** Active working directory for this Engine. */
  cwd: string;
  /** LLM credentials/endpoint for tools that need to make their own calls. */
  llmConfig: LLMConfig;
  /** Active model pool (Arena reads this to pick participants). */
  modelPool?: ModelPool;
  /** Tool registry (ToolSearch reads this to enumerate available tools). */
  toolRegistry: ToolRegistry;
  /** UI-backed AskUserQuestion handler. Undefined → headless mode. */
  askUser?: AskUserFn;
  /** Sub-agent spawner (Agent tool). Undefined → Agent tool unavailable. */
  subAgentSpawner?: SubAgentSpawner;
  /** Optional cancellation signal for the whole turn. */
  signal?: AbortSignal;
}

/**
 * Per-Engine container that produces a fresh ToolContext on demand.
 * Engine creates one of these in run() and passes it to ToolExecutor.
 */
export class ServiceContainer {
  constructor(private readonly base: ToolContext) {}

  /** Snapshot of the context at this moment. */
  get(): ToolContext {
    return this.base;
  }

  /** Create a derived context with overridden fields (e.g. per-call signal). */
  withSignal(signal: AbortSignal): ToolContext {
    return { ...this.base, signal };
  }
}

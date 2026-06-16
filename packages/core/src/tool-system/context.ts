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
import type { SandboxBackend } from "./sandbox/index.js";
import type { HookRegistry } from "../hooks/registry.js";
import type { Engine } from "../engine/engine.js";

/** One choice in a multiple-choice AskUserQuestion. */
export interface AskUserChoice {
  label: string;
  description: string;
}

/**
 * Optional rendering hints / multiple-choice options carried alongside the
 * question. Implementations may ignore unknown fields — they're additive.
 */
export interface AskUserOptions {
  /** Short chip-style label (≤12 chars) shown above the question. */
  header?: string;
  /** Multiple-choice options. When omitted, the UI falls back to free-text. */
  options?: AskUserChoice[];
  /** Allow the user to pick more than one option. Defaults to false. */
  multiSelect?: boolean;
  /**
   * When true, the UI must offer ONLY the given `options` — no "其它…"
   * free-text escape hatch. Used by closed-set decisions (e.g. a path-permission
   * 允许本次/拒绝 prompt) where the answer is interpreted by an exact label
   * match, so a free-typed answer like "允许" would never match and silently
   * deny. Ignored unless `options` is non-empty.
   */
  optionsOnly?: boolean;
}

/**
 * Function the host UI / server uses to ask the user a question.
 *
 * Second argument is optional for backwards compatibility — callers that
 * only need free text can omit it; backends that don't support options
 * should ignore the field and prompt for free text.
 *
 * Return value:
 *   - Free-text mode: the user's typed answer (or "(user declined to answer)").
 *   - Multiple-choice mode: the selected label, or comma-separated labels for
 *     multiSelect, or "Other: <typed>" when the user picks the implicit
 *     Other... entry.
 */
export type AskUserFn = (question: string, opts?: AskUserOptions) => Promise<string>;

/** Spawn a sub-agent. Returns the produced text or throws. */
export interface SubAgentSpawnRequest {
  agentId: string;
  description: string;
  prompt: string;
  maxTurns: number;
  signal: AbortSignal;
  /**
   * Per-call override for where the spawned child Engine's stream events go.
   * Defaults to `spawner.parentStream` (the parent UI). Background sub-agents
   * pass a transcriptSink here so per-event detail is captured in the agent's
   * transcript instead of leaking into the main feed; the main feed still
   * gets `agent_start` / `agent_end` markers via `spawner.parentStream`.
   */
  streamOverride?: StreamCallback;
  /**
   * Optional ModelPool key for the child Engine's LLM (e.g. "flash").
   * Undefined → child inherits the parent's model (current behavior).
   */
  model?: string;
  /**
   * Optional tool-name allowlist for the child. When set, the child's tool
   * pool is restricted to these names (still minus the nested-agent tools).
   * Undefined → child inherits the parent's full tool set (current behavior).
   */
  toolAllowlist?: string[];
  /**
   * Optional skill-name allowlist for the child (hard isolation). When set,
   * the child only sees/invokes these skills in its system prompt and Skill
   * tool. Undefined → child inherits the parent's full skill pool.
   */
  skillAllowlist?: string[];
  /**
   * Optional per-call system prompt appended to the child Engine's prompt
   * (the role definition's Markdown body). Undefined → child inherits only
   * the parent's appendSystemPrompt (current behavior).
   */
  appendSystemPrompt?: string;
  /** True for read-only reviewer/researcher children; tunes investigation guard reminders. */
  readOnlySession?: boolean;
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
  /**
   * Reusable sub-agent role definitions (loaded from .code-shell/agents/*.md).
   * The Agent tool reads this to resolve `agent_type`. Undefined → only the
   * ephemeral (inline prompt) mode is available.
   */
  agentDefinitions?: import("../agent/agent-definition-registry.js").AgentDefinitionRegistry;
  /**
   * True when this Engine is itself a sub-agent. Set from EngineConfig.
   * The Agent tool refuses to spawn when this is true — runtime check
   * layered on top of the tool-list strip in Engine.spawn so a registry
   * regression can't leak nested spawns.
   */
  isSubAgent?: boolean;
  /**
   * Active sandbox backend for the Bash tool. Undefined falls back to "off"
   * (plain spawn). Headless runs default to an OS-level sandbox; the REPL
   * defaults to off because a human is in the loop to approve commands.
   */
  sandbox?: SandboxBackend;
  /** Optional cancellation signal for the whole turn. */
  signal?: AbortSignal;
  /**
   * Engine-owned HookRegistry. Tools that emit lifecycle hooks
   * (notification, file_changed for non-Write/Edit paths, custom
   * tool-defined events) use this. Undefined for legacy callers /
   * standalone tests; tools must tolerate absence.
   */
  hooks?: HookRegistry;
  /**
   * Per-turn stream sink (engine.run's `onStream`). Tools that need to
   * push UI events independently of their return value use this — e.g.
   * TodoWrite emits a `task_update` so the desktop pinned panel and
   * tui task list refresh immediately rather than waiting for the LLM
   * to surface the snapshot in the next turn. Undefined in
   * headless/test mode; tools must tolerate absence.
   */
  streamCallback?: StreamCallback;
  /** Whether the owning Engine is currently in plan mode. Replaces the
   *  removed module-level `isInPlanMode()` singleton. */
  planMode: boolean;
  /**
   * The owning Engine's permission mode. Path policy reads this so that
   * `bypassPermissions` (the user's "完全访问") skips the path-approval prompt
   * entirely — matching the tool-permission backend and CC, where bypass
   * skips ALL checks including path validation. Undefined → treat as
   * "default" (always enforce). */
  permissionMode?: string;
  /** The Engine that built this context. Lets tools call back into the engine
   *  (e.g. ctx.engine.setPlanMode(true/false)) without a module-level singleton. */
  engine: Engine;
  /**
   * sessionId of the Engine.run() turn this context was built for. Tools
   * that emit session-scoped side effects (today: background-agent
   * completion notifications) attribute the event by this. Undefined for
   * ad-hoc contexts built outside Engine.run() — e.g. memory.auto_dream's
   * narrow context, or standalone tool tests. (B2 — Gate 1, standard §S3.)
   */
  sessionId?: string;
  /**
   * Skill names the user has hidden from the LLM (full namespaced names
   * for plugin skills, e.g. "docs:pdf"). The skill builtin tool uses
   * this to refuse direct invocation of a disabled skill so the UI
   * toggle is honored at dispatch time, not just in the prompt listing.
   * Populated from `settings.disabledSkills` by Engine.run().
   */
  disabledSkills?: string[];
  /**
   * Plugin names the user has totally disabled. Every skill whose
   * namespaced name starts with `${pluginName}:` is hidden from the
   * LLM and rejected at dispatch by the skill builtin tool with a
   * distinct "disabled plugin" message. Populated from
   * `settings.disabledPlugins` by Engine.run().
   */
  disabledPlugins?: string[];
  /**
   * Sub-agent skill allowlist (hard isolation). When set, this sub-agent may
   * only see/invoke skills in this list — applied on top of the disabled
   * lists. Undefined → inherit the parent's full pool (current behavior).
   * Comes from the agent role definition's `skills:` frontmatter, threaded
   * through SubAgentSpawnRequest.skillAllowlist into the child Engine.
   */
  skillAllowlist?: string[];
  /**
   * Background-shell manager (Bash run_in_background + BashOutput / KillShell
   * / ListShells). Undefined → the tools fall back to the process-local
   * `backgroundShellManager` singleton. Threaded explicitly so tests (and
   * any future per-engine isolation) can inject their own instance.
   */
  backgroundShells?: import("../runtime/background-shell.js").BackgroundShellManager;
  /**
   * False in unattended automation/cron runs — `Bash(run_in_background=true)`
   * is rejected and the three background-shell tools are stripped (design
   * §5.5): no one is watching to reap a long-lived dev server. Defaults to
   * true (interactive sessions allow it).
   */
  allowBackgroundShells?: boolean;
  /**
   * Builtin tool names the project's capabilityOverrides marked `off` for
   * this cwd. Engine.run() already HIDES these from the LLM-visible tool
   * list, but the model can still NAME a hidden builtin (hallucinated, or
   * remembered from an earlier turn when it was visible). The executor reads
   * this set and rejects such a call — turning `off` into a real execution
   * gate, not just a prompt-visibility filter. Empty/undefined for
   * sub-agents and no-cwd contexts (same as readBuiltinOverride).
   */
  disabledBuiltins?: Set<string>;
  /**
   * MCP servers THIS session's merged config enables (keys of
   * config.mcpServers, enabled!==false). The pool + registry are
   * worker-shared (B1), so tools registered by another project's session live
   * in the same registry — the engine hides them from this session's tool
   * list and the executor rejects calls to them via this set. Undefined =
   * no gating (sub-agents / tests whose registries carry no MCP tools).
   */
  allowedMcpServers?: Set<string>;
  /**
   * Project-scoped extra environment variables (the user's
   * `localEnvironment.env` KEY=VALUE pairs for this cwd). Layered on top of
   * the shell env that the Bash tool and background shells build, so a project
   * can inject e.g. `DATABASE_URL` / `NODE_ENV` into every command it runs.
   * Unlike the sandbox allowlist, these bypass the deny regex — the user put
   * them in project settings deliberately. Undefined for sub-agents and
   * no-cwd contexts (populated from settings by Engine.buildToolContext()).
   */
  shellEnv?: Record<string, string>;
  /**
   * Browser automation bridge (browser_snapshot / click / type / navigate /
   * scroll). The renderer implements it on top of the webview's CDP
   * (Accessibility.getFullAXTree + Input.dispatchMouseEvent). Undefined →
   * headless / no browser panel → the browser tools degrade with a clear error.
   * See tool-system/browser-bridge.ts and the MVP spec
   * docs/superpowers/specs/2026-06-16-browser-automation-mvp.md.
   */
  browser?: import("./browser-bridge.js").BrowserBridge;
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

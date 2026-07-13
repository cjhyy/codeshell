/**
 * Public Engine configuration & result types.
 *
 * Extracted out of engine/engine.ts so consumers (protocol server, run
 * factory, product layer, settings/disk-defaults, SDK index) can import the
 * Engine's *types* without importing the 3000-line Engine *implementation* —
 * which would pull the whole engine module (and its transitive deps) into a
 * type-only consumer and make engine.ts a "type water tower". engine.ts
 * re-exports these names, so existing `import { EngineConfig } from
 * "../engine/engine.js"` callers keep working; new callers should prefer
 * `engine/types.js`.
 */

import type {
  ClientDefaults,
  LLMConfig,
  SessionOrigin,
  TerminalReason,
  TokenUsage,
} from "../types.js";
import type { AgentPresetName } from "../preset/index.js";
import type { GoalConfig, GoalTerminationReason } from "./goal.js";
import type { ApprovalBackend, ApprovalRouter } from "../tool-system/permission.js";
import type { SandboxConfig } from "../tool-system/sandbox/index.js";
import type { CostStateStore } from "./cost-store.js";
import type { AskUserFn } from "../tool-system/builtin/ask-user.js";
import type { SettingsScope } from "../settings/manager.js";
import type { EngineRuntime } from "./runtime.js";
import type { HookEventName } from "../hooks/events.js";
import type { HookHandler } from "../hooks/registry.js";
import type { CapabilityModule } from "../tool-system/capability-module.js";

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
  /** Trusted optional product capabilities installed by the owning host. */
  capabilities?: readonly CapabilityModule[];
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
  /** Connection-scoped permission approval router supplied by an interactive host. */
  approvalRouter?: ApprovalRouter;
  hooks?: EngineHookConfig[];
  askUser?: AskUserFn;
  /** Browser automation bridge (browser_* tools). Wired by the host (desktop)
   *  after construction via setBrowserBridge. Undefined → tools degrade. */
  browserBridge?: import("../tool-system/browser-bridge.js").BrowserBridge;
  /** Host-backed workspace switch bridge (desktop only). */
  workspaceBridge?: import("../tool-system/workspace-bridge.js").WorkspaceBridge;
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
   * Host-specific builtin tool surface. Desktop replaces the legacy core
   * worktree tools with SwitchSessionWorkspace because Electron main owns the
   * authoritative workspace switch service and UI refresh path.
   */
  builtinToolHost?: "desktop";
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
  /**
   * Workspace trust for the project directory (`cwd`). When explicitly `false`,
   * dangerous fields committed into the project's own
   * `.code-shell/settings.{json,local.json}` (permissions / env / hooks /
   * mcpServers / localEnvironment) are stripped before merge, so a cloned
   * malicious repo can't self-authorize permission rules, inject env
   * (BASH_ENV/LD_PRELOAD), register hooks, or auto-connect MCP servers. Safe
   * fields still apply. The user/managed layers are never gated.
   *
   * Undefined / true keeps the pre-trust behavior (fully trusted) so embedders
   * that don't wire a trust store are unaffected. Host terminals (desktop) pass
   * the real decision from their per-directory trust store; when it's "unknown"
   * they should pass `false` (fail-closed) until the user grants trust.
   */
  projectTrusted?: boolean;
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
  /** Goal-specific stop outcome; omitted for ordinary completion/met verdicts. */
  goalTermination?: GoalTerminationReason;
  sessionId: string;
  turnCount: number;
  usage: TokenUsage;
}

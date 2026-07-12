/**
 * Hook event type definitions.
 */
import type { GoalTerminationReason } from "../engine/goal.js";

/**
 * Lifecycle hooks the engine emits.
 *
 * **Currently emitted** (handlers registered here will actually fire):
 *   - on_session_start / on_session_end    (engine.ts) — fires once per Engine.run().
 *                                          on_session_start handlers may return
 *                                          `messages` to inject a <system-reminder>
 *                                          at the head of the conversation, before
 *                                          the current user prompt.
 *   - on_agent_start / on_agent_end        (engine.ts) — notify-only; returned
 *                                          messages are NOT consumed (the loop
 *                                          is already armed by the time these
 *                                          fire). Use on_session_start instead.
 *   - user_prompt_submit                   (engine.ts) — fires once per run() for
 *                                          every new user prompt (cold-start and
 *                                          resume both qualify). Returned messages
 *                                          are merged into the same lifecycle
 *                                          <system-reminder> as on_session_start.
 *   - on_turn_start / on_turn_end          (turn-loop.ts) — on_turn_start handlers
 *                                          may return `messages` to inject a
 *                                          per-turn reminder appended to the
 *                                          conversation right before the model call.
 *   - on_stop                              (turn-loop.ts) — fires when the model
 *                                          returns no tool calls and the loop is
 *                                          about to return reason "completed". A
 *                                          handler returning `continueSession: true`
 *                                          (with `messages`) BLOCKS termination:
 *                                          the messages are injected as a
 *                                          <system-reminder> and the loop runs
 *                                          another turn instead of stopping. This
 *                                          is the seam Goal mode uses (see
 *                                          goal-stop-hook.ts). Bounded by a
 *                                          consecutive-block cap (maxStopBlocks)
 *                                          and maxTurns. ctx.data carries `goal`,
 *                                          `finalText`, `turnCount`. Distinct from
 *                                          the built-in Goal judge's recent
 *                                          conversation, which stays on a private
 *                                          TurnLoop-to-hook closure and is never
 *                                          exposed through HookContext.
 *                                          HookResult.stop, which controls the hook
 *                                          CHAIN, not agent termination.
 *   - pre_tool_use / post_tool_use         (executor.ts) — pre_tool_use honors
 *                                          `decision: "deny"` to short-circuit
 *                                          the call (executor.ts:131).
 *   - on_tool_start / on_tool_end          (executor.ts)
 *   - file_changed                         (executor.ts, Write/Edit only)
 *   - on_permission_check                  (executor.ts) — fires after the
 *                                          classifier runs and before its
 *                                          decision is acted on. Handler can
 *                                          override via `decision`; the
 *                                          override is logged as
 *                                          `permission.hook_override`. ctx.data
 *                                          carries `classifierDecision` so
 *                                          handlers can branch on the rule
 *                                          set's verdict.
 *   - post_compact                         (turn-loop.ts) — fires after
 *                                          ContextManager.manageAsync() runs
 *                                          a non-micro compaction. Handlers
 *                                          may return `messages` to inject a
 *                                          <system-reminder> into the same
 *                                          turn before the model call. ctx.data
 *                                          carries `strategy` (summary/snip/
 *                                          window/emergency), `beforeTokens`,
 *                                          `afterTokens`. Microcompact is
 *                                          intentionally suppressed.
 *   - notification                         (agent.ts) — fired when a background
 *                                          sub-agent transitions to a terminal
 *                                          state. ctx.data carries `kind`
 *                                          ("agent_completed" / "agent_failed" /
 *                                          "agent_cancelled"), `agentId`,
 *                                          `name`, `description`, plus
 *                                          `finalText` (completed) or `error`
 *                                          (failed). Fired void — handler
 *                                          latency does not block the main
 *                                          loop. Not consumed by the engine
 *                                          (bg-agent feed renders the same
 *                                          info via notificationQueue);
 *                                          intended for shell hooks (osascript
 *                                          / desktop notifications).
 *
 * All Engine-side emits run through Engine.emitHook / TurnLoop.emitHook, which
 * auto-merge `isSubAgent` (and sessionId, for turn-loop) into ctx.data so
 * handlers can skip noisy injections for spawned children.
 *
 * **Reserved / not-yet-emitted** (defined so downstream can register handlers
 * in anticipation; wire the emitter before relying on them):
 *   - pre_compact   — would require pre-flight prediction inside
 *                     ContextManager; current implementation only knows
 *                     after-the-fact (use post_compact instead).
 */
export type HookEventName =
  | "on_agent_start"
  | "on_agent_end"
  | "on_turn_start"
  | "on_turn_end"
  | "on_stop"
  | "on_tool_start"
  | "on_tool_end"
  | "on_permission_check"
  | "on_session_start"
  | "on_session_end"
  | "pre_tool_use"
  | "post_tool_use"
  | "user_prompt_submit"
  | "agent_direction_submit"
  | "pre_compact"
  | "post_compact"
  | "file_changed"
  | "notification";

export interface HookContext {
  eventName: HookEventName;
  data: Record<string, unknown>;
  sessionId?: string;
  turnNumber?: number;
}

export interface HookResult {
  /** If true, stop the hook chain */
  stop?: boolean;
  /**
   * For on_stop: if true, BLOCK agent termination — the loop injects this
   * result's `messages` and runs another turn instead of returning
   * "completed". Distinct from `stop` (which only short-circuits the hook
   * chain). Ignored for non-on_stop events. Bounded by maxStopBlocks.
   */
  continueSession?: boolean;
  /** For on_stop: typed Goal-run stop outcome propagated to TurnLoop/Engine. */
  goalTermination?: GoalTerminationReason;
  /** Modified data to pass along */
  data?: Record<string, unknown>;
  /** Additional messages to inject */
  messages?: string[];
  /** Allow/deny/ask override for permission hooks */
  decision?: "allow" | "deny" | "ask";
  /**
   * For pre_tool_use: replace the tool's args before execution. Used by
   * "sanitizer" handlers (e.g. redact secrets in Bash commands, normalize
   * file paths, inject a default flag). Last handler in the chain wins.
   * Args are re-validated against the tool's input schema before the
   * tool runs, so a malformed updatedInput still surfaces as an
   * "Invalid input" error rather than silently passing through.
   */
  updatedInput?: Record<string, unknown>;
  /**
   * For post_tool_use: text appended to the tool's content (visible to
   * the model on the next LLM call). Used by linter/typecheck handlers
   * to surface results without re-running the tool. Multiple handlers'
   * additionalContext entries are joined with two newlines.
   */
  additionalContext?: string;
  /**
   * For user_prompt_submit: replace the most recent user message text
   * with this string. Last handler wins. Used to auto-prepend project
   * context, mask secrets, or rewrite shorthand prompts. The original
   * prompt is logged at info level for audit purposes.
   */
  updatedPrompt?: string;
}

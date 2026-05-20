/**
 * Hook event type definitions.
 */

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
 *   - pre_tool_use / post_tool_use         (executor.ts) — pre_tool_use honors
 *                                          `decision: "deny"` to short-circuit
 *                                          the call (executor.ts:131).
 *   - on_tool_start / on_tool_end          (executor.ts)
 *   - file_changed                         (executor.ts, Write/Edit only)
 *
 * All Engine-side emits run through Engine.emitHook / TurnLoop.emitHook, which
 * auto-merge `isSubAgent` (and sessionId, for turn-loop) into ctx.data so
 * handlers can skip noisy injections for spawned children.
 *
 * **Reserved / not-yet-emitted** (defined so downstream can register handlers
 * in anticipation; wire the emitter before relying on them):
 *   - on_permission_check
 *   - pre_compact / post_compact / notification
 */
export type HookEventName =
  | "on_agent_start"
  | "on_agent_end"
  | "on_turn_start"
  | "on_turn_end"
  | "on_tool_start"
  | "on_tool_end"
  | "on_permission_check"
  | "on_session_start"
  | "on_session_end"
  | "pre_tool_use"
  | "post_tool_use"
  | "user_prompt_submit"
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
  /** Modified data to pass along */
  data?: Record<string, unknown>;
  /** Additional messages to inject */
  messages?: string[];
  /** Allow/deny/ask override for permission hooks */
  decision?: "allow" | "deny" | "ask";
}

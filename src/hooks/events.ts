/**
 * Hook event type definitions.
 */

/**
 * Lifecycle hooks the engine emits.
 *
 * **Currently emitted** (handlers registered here will actually fire):
 *   - on_agent_start / on_agent_end        (engine.ts)
 *   - on_turn_start / on_turn_end          (turn-loop.ts)
 *   - pre_tool_use / post_tool_use         (executor.ts)
 *   - on_tool_start / on_tool_end          (executor.ts)
 *   - file_changed                         (executor.ts, Write/Edit only)
 *
 * **Reserved / not-yet-emitted** (defined so downstream can register handlers
 * in anticipation; wire the emitter before relying on them):
 *   - on_permission_check / on_session_start / on_session_end
 *   - user_prompt_submit / pre_compact / post_compact / notification
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

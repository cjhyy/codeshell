/**
 * Hook event type definitions.
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
  // New hooks matching Claude Code
  | "pre_tool_use"      // Can approve/deny/ask before tool execution
  | "post_tool_use"     // After tool execution, can modify result
  | "user_prompt_submit" // Before user input is sent to model
  | "pre_compact"       // Before context compaction
  | "post_compact"      // After context compaction
  | "file_changed"      // When a file is modified by a tool
  | "notification";     // When a notification should be shown

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

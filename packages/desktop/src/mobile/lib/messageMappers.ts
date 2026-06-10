/**
 * Pure mappers between server payloads and the shapes the phone UI uses:
 *  - room messages (RoomManager.messages.jsonl) → streamReducer events
 *  - AskUser approval args → option labels
 * Extracted from useRemoteApp so they're unit-testable without a DOM.
 */

/**
 * Map a room message (one messages.jsonl line) into a reducer event.
 *
 * The shapes MUST match what RoomManager actually persists (room-manager.ts
 * onAgentEvent/send): `{from:'agent',type:'text'}`, `{type:'tool',tool,summary}`,
 * `{type:'tool_result',summary,isError}`, `{type:'turn_end',reason}`,
 * `{from:'system',type:'error',text}`, `{from:'system',type:'agent_exit',reason}`,
 * and `{from:'system',type:'room_created',text}`. Anything unmapped → `_noop`.
 */
export function roomMsgToEvent(msg: unknown): unknown {
  const m = msg as Record<string, unknown>;
  const from = m.from as string;
  const type = m.type as string;
  // A user line: the agent's resident transcript records the prompt verbatim.
  if (from === "user") return { type: "user_message", text: m.text };
  // RoomManager writes agent prose as type:"text" (NOT "text_delta"); the
  // reducer's text_delta path opens/appends an assistant bubble, which renders a
  // whole-message text correctly too.
  if (type === "text") return { type: "text_delta", text: m.text };
  // Tool start carries a human `summary` (not structured args). Surface it via
  // the tool item's summary field; the seq gives a stable id to seal later.
  if (type === "tool")
    return {
      type: "tool_use_start",
      toolCall: { id: `room-tool-${m.seq ?? ""}`, toolName: m.tool, summary: m.summary },
    };
  // Tool result is a coarse summary with no id back to its start → seal the last
  // open tool item with it.
  if (type === "tool_result")
    return { type: "room_tool_result", summary: m.summary, isError: m.isError };
  if (type === "turn_end") return { type: "turn_complete", reason: m.reason ?? "completed" };
  if (type === "error") return { type: "error", error: m.text };
  if (type === "agent_exit") return { type: "error", error: `agent 退出 (code ${m.reason ?? "?"})` };
  // room_created (audit anchor) and anything else have no visible rendering.
  return { type: "_noop" };
}

/** Detect an AskUser-style approval and pull its option labels + optionsOnly. */
export function extractAskUserOptions(
  args: Record<string, unknown> | undefined,
): { options: string[]; optionsOnly: boolean } | undefined {
  if (!args) return undefined;
  const opts = args.options;
  if (Array.isArray(opts)) {
    const labels = opts
      .map((o) => (typeof o === "string" ? o : (o as { label?: string })?.label))
      .filter((l): l is string => typeof l === "string");
    if (labels.length) return { options: labels, optionsOnly: args.optionsOnly === true };
  }
  return undefined;
}

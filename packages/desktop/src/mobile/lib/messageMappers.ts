/**
 * Pure mappers between server payloads and the shapes the phone UI uses:
 *  - room messages (RoomManager.messages.jsonl) → streamReducer events
 *  - AskUser approval args → option labels
 * Extracted from useRemoteApp so they're unit-testable without a DOM.
 */

/** Map a room message (one messages.jsonl line) into a reducer event. */
export function roomMsgToEvent(msg: unknown): unknown {
  const m = msg as Record<string, unknown>;
  const from = m.from as string;
  const type = m.type as string;
  if (from === "user") return { type: "user_message", text: m.text };
  if (type === "text_delta") return { type: "text_delta", text: m.text };
  if (type === "tool")
    return { type: "tool_use_start", toolCall: { id: String(m.seq ?? ""), toolName: m.tool, args: {} } };
  if (type === "turn_end") return { type: "turn_complete", reason: m.reason ?? "completed" };
  if (type === "agent_exit") return { type: "error", error: `agent 退出 (code ${m.code ?? "?"})` };
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

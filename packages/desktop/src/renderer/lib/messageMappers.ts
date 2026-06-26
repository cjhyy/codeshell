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
  // RoomManager writes agent prose as type:"text" — each line is a COMPLETE
  // chunk claude emitted between tool calls, not a token delta. Map to
  // `assistant_text` (its own finished bubble) so consecutive chunks render as
  // separate bubbles interleaved with tools ("说一句 → 干活 → 再说一句"),
  // instead of text_delta folding them all into one bubble.
  if (type === "text") return { type: "assistant_text", text: m.text };
  // Tool start carries a human `summary` (not structured args). Surface it via
  // the tool item's summary field. Prefer the real claude tool_use id (toolId)
  // so the result can be paired by id; fall back to the seq-derived id for
  // legacy messages that predate id threading.
  if (type === "tool") {
    const toolId = typeof m.toolId === "string" ? m.toolId : undefined;
    return {
      type: "tool_use_start",
      toolCall: { id: toolId ?? `room-tool-${m.seq ?? ""}`, toolName: m.tool, summary: m.summary },
    };
  }
  // Tool result: if we have the real id, emit an id-paired `tool_result` so the
  // reducer seals exactly the matching card (correct under parallel tools).
  // Without an id (legacy), fall back to `room_tool_result` (seal the last open
  // tool) — the old, best-effort behavior.
  if (type === "tool_result") {
    const toolId = typeof m.toolId === "string" ? m.toolId : undefined;
    if (toolId) {
      return {
        type: "tool_result",
        result: { id: toolId, result: m.summary, isError: m.isError },
      };
    }
    return { type: "room_tool_result", summary: m.summary, isError: m.isError };
  }
  if (type === "turn_end") return { type: "turn_complete", reason: m.reason ?? "completed" };
  if (type === "error") return { type: "error", error: m.text };
  if (type === "agent_exit") return { type: "error", error: `agent 退出 (code ${m.reason ?? "?"})` };
  // room_created (audit anchor) and anything else have no visible rendering.
  return { type: "_noop" };
}

/**
 * Map a `room.history.ok` payload's `messages` into replay events. The payload
 * comes off the WebSocket from the (untrusted) host — `messages` may be missing
 * or, on a malformed/hostile message, not an array. `(x ?? []).map` only guards
 * null/undefined, so `messages: 123` would throw a TypeError and white-screen
 * the phone. Guard with Array.isArray → non-arrays yield an empty replay.
 */
export function roomHistoryToEvents(messages: unknown): unknown[] {
  return Array.isArray(messages) ? messages.map(roomMsgToEvent) : [];
}

/**
 * Map a `ccRoom.readHistory.ok` payload's `messages` (core HistoryMessage shape:
 * `{role, text, tools?}`) into replay events for the chat reducer. Like
 * roomHistoryToEvents, the payload is untrusted off the WebSocket, so guard the
 * array and each entry. A message expands to its tool starts first (so the tools
 * render under the turn) followed by the prose bubble.
 */
export function ccHistoryToEvents(messages: unknown): unknown[] {
  if (!Array.isArray(messages)) return [];
  const out: unknown[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as Record<string, unknown> | null;
    if (!m || typeof m !== "object") continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    if (role === "user") {
      out.push({ type: "user_message", text: typeof m.text === "string" ? m.text : "" });
      continue;
    }
    // Assistant: prose first (its own finished bubble via assistant_text), then
    // any tool calls — matching how claude actually emits a turn ("说一句 → 干
    // 活"). In practice each CC transcript message is single-type (pure text OR
    // pure tools, never mixed), so only one branch fires per message; ordering
    // across messages is preserved by the loop. Each text chunk is a SEPARATE
    // bubble (assistant_text), not folded.
    const text = typeof m.text === "string" ? m.text : "";
    if (text) out.push({ type: "assistant_text", text });
    const tools = Array.isArray(m.tools) ? m.tools : [];
    for (let t = 0; t < tools.length; t++) {
      const tool = tools[t] as Record<string, unknown> | null;
      if (!tool || typeof tool !== "object") continue;
      out.push({
        type: "tool_use_start",
        toolCall: {
          id: `cc-hist-${i}-${t}`,
          toolName: typeof tool.name === "string" ? tool.name : "tool",
          summary: typeof tool.summary === "string" ? tool.summary : undefined,
        },
      });
    }
    out.push({ type: "turn_complete", reason: "completed" });
  }
  return out;
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

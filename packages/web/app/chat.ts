// packages/web/app/chat.ts
//
// Pure chat-view state: fold core-protocol stream events (and loaded
// transcript history) into a renderable message list per session. Kept free
// of React/DOM so it is unit-testable under bun.

export interface ChatItem {
  kind: "user" | "assistant" | "tool" | "error" | "info";
  text: string;
  /** In-progress assistant text accumulates deltas until the turn settles. */
  streaming?: boolean;
}

export interface ChatViewState {
  items: ChatItem[];
  running: boolean;
}

export const emptyChat: ChatViewState = { items: [], running: false };

export function appendUserMessage(state: ChatViewState, text: string): ChatViewState {
  return { items: [...state.items, { kind: "user", text }], running: true };
}

/** Fold one agent/streamEvent payload event into the view state. */
export function foldStreamEvent(
  state: ChatViewState,
  event: Record<string, unknown>,
): ChatViewState {
  const type = event.type as string | undefined;
  switch (type) {
    case "stream_request_start":
      return { ...state, running: true };
    case "text_delta": {
      const text = String(event.text ?? "");
      if (!text) return state;
      const items = [...state.items];
      const last = items[items.length - 1];
      if (last && last.kind === "assistant" && last.streaming) {
        items[items.length - 1] = { ...last, text: last.text + text };
      } else {
        items.push({ kind: "assistant", text, streaming: true });
      }
      return { ...state, items };
    }
    case "tool_use_start": {
      const call = event.toolCall as { name?: string } | undefined;
      return {
        ...state,
        items: [...sealStreaming(state.items), { kind: "tool", text: `⚙ ${call?.name ?? "tool"}` }],
      };
    }
    case "turn_complete":
      return { items: sealStreaming(state.items), running: false };
    case "error":
      return {
        items: [...sealStreaming(state.items), { kind: "error", text: String(event.error ?? "error") }],
        running: false,
      };
    default:
      return state;
  }
}

/** Mark any trailing streaming assistant item as settled. */
function sealStreaming(items: ChatItem[]): ChatItem[] {
  const last = items[items.length - 1];
  if (!last || !last.streaming) return items;
  return [...items.slice(0, -1), { ...last, streaming: false }];
}

/**
 * Best-effort mapping of a persisted transcript (session_detail) into chat
 * items. Transcript event shapes vary across event kinds; anything we don't
 * recognize is skipped rather than rendered wrong.
 */
export function chatFromTranscript(events: Array<Record<string, unknown>>): ChatViewState {
  const items: ChatItem[] = [];
  for (const event of events) {
    const message = (event.message ?? event) as Record<string, unknown>;
    const role = message.role as string | undefined;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractText(message.content);
    if (!text) continue;
    // Skip synthetic frames (system reminders ride user turns).
    if (role === "user" && text.startsWith("<system-reminder>")) continue;
    items.push({ kind: role, text });
  }
  return { items, running: false };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && (block as { type?: string }).type === "text"
          ? String((block as { text?: string }).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

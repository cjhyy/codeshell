// packages/web/app/chat.ts
//
// Transcript replay + title helpers for the standalone SPA. Live stream
// folding is handled by the shared reducer in ../src/lib/streamReducer —
// do NOT reintroduce a local fold here.
import { initialChatState, type ChatItem, type ChatState } from "../src/lib/streamReducer.js";

export { initialChatState, type ChatItem, type ChatState };

/**
 * Best-effort mapping of a persisted transcript (session_detail) into chat
 * items. Transcript event shapes vary across event kinds; anything we don't
 * recognize is skipped rather than rendered wrong.
 */
export function chatFromTranscript(events: Array<Record<string, unknown>>): ChatState {
  const items: ChatItem[] = [];
  let seq = 0;
  for (const event of events) {
    const message = (event.message ?? event) as Record<string, unknown>;
    const role = message.role as string | undefined;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractText(message.content);
    if (!text) continue;
    // Skip synthetic frames (system reminders ride user turns).
    if (role === "user" && text.startsWith("<system-reminder>")) continue;
    seq += 1;
    items.push(
      role === "user"
        ? { kind: "user", id: `h-${seq}`, text }
        : { kind: "assistant", id: `h-${seq}`, text, reasoning: "", done: true },
    );
  }
  return { ...initialChatState(), items, seq };
}

/** Session-rail title: reducer-pushed title, else first user line, else id. */
export function sessionTitle(state: ChatState | undefined, sessionId: string): string {
  if (state?.title) return state.title;
  const firstUser = state?.items.find((item) => item.kind === "user");
  if (firstUser && firstUser.kind === "user" && firstUser.text.trim()) {
    const line = firstUser.text.trim().split("\n")[0];
    return line.length > 32 ? `${line.slice(0, 32)}…` : line;
  }
  return sessionId.slice(0, 8);
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

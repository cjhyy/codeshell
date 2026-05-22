/**
 * Hook message injection helper.
 *
 * Handlers return raw markdown strings via HookResult.messages. The emit
 * site uses wrapHookMessages() to package them into a single user-role
 * <system-reminder> Message so the model sees them as one block instead
 * of a noisy sequence of separate user turns.
 *
 * Contract:
 *   - Handlers do NOT wrap their own <system-reminder>; emit-site owns the
 *     wrapper. Keeps formatting consistent and lets us evolve it (e.g. add
 *     a trailing close-tag, tag attributes) without touching every handler.
 *   - Empty / whitespace-only messages are dropped before wrapping; if
 *     nothing remains, returns null (caller skips the injection).
 *   - Multiple handlers' messages are joined with a blank line between
 *     blocks so each is visually distinct inside the reminder.
 */

import type { Message } from "../types.js";

export function wrapHookMessages(messages: string[] | undefined): Message | null {
  if (!messages?.length) return null;
  const cleaned = messages.map((m) => m.trim()).filter((m) => m.length > 0);
  if (cleaned.length === 0) return null;
  const body = cleaned.join("\n\n");
  return {
    role: "user",
    content: `<system-reminder>\n${body}\n</system-reminder>`,
  };
}

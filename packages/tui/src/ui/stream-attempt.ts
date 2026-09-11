import type { ChatEntry } from "./store.js";

/** Track only IDs present before a model request. A failed request may have
 * flushed prose and tool placeholders, but never executed those tools yet. */
export class StreamAttempt {
  private messageId: string | undefined;
  private previousIds = new Set<string>();

  begin(messageId: string | undefined, entries: readonly ChatEntry[]): void {
    this.messageId = messageId;
    this.previousIds = new Set(entries.map((entry) => entry.id));
  }

  clear(): void {
    this.messageId = undefined;
    this.previousIds.clear();
  }

  revoke(messageId: string, entries: ChatEntry[]): ChatEntry[] | null {
    if (this.messageId !== messageId) return null;
    const remaining = entries.filter((entry) => {
      if (this.previousIds.has(entry.id)) return true;
      if (
        entry.type !== "assistant_text" &&
        entry.type !== "thinking" &&
        entry.type !== "tool_start" &&
        entry.type !== "tool_running"
      )
        return true;
      return entry.agentId !== undefined;
    });
    this.clear();
    return remaining;
  }
}

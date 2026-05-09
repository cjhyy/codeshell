/**
 * ChatStore — external state store for chat messages.
 *
 * Moves chatLog out of React useState to avoid full component tree
 * re-renders on every message update. Components subscribe to specific
 * slices via useSyncExternalStore.
 */

type ChatEntryData =
  | { type: "user"; text: string }
  | { type: "assistant_text"; text: string; streaming: boolean; agentId?: string }
  | { type: "tool_start"; toolName: string; args: Record<string, unknown>; toolCallId?: string; agentId?: string }
  | { type: "tool_running"; toolName: string; agentId?: string }
  | { type: "tool_result"; toolName: string; result?: string; error?: string; agentId?: string }
  | { type: "thinking"; agentId?: string; content?: string }
  | { type: "error"; error: string; errorKind?: ErrorKind; agentId?: string }
  | { type: "status"; reason: string }
  | { type: "system"; subtype: SystemSubtype; text?: string }
  | { type: "agent_start"; agentId: string; description: string }
  | { type: "agent_end"; agentId: string; description: string; error?: string };

/** Specialized error kinds for smart rendering. */
export type ErrorKind =
  | "rate_limit"
  | "context_limit"
  | "invalid_api_key"
  | "api_timeout"
  | "credit_balance"
  | "generic";

/** System message subtypes. */
export type SystemSubtype =
  | "compact_boundary"
  | "memory_saved"
  | "turn_duration"
  | "info";

export type ChatEntry = ChatEntryData & { id: string };

let entryIdCounter = 0;
export function createEntry(data: ChatEntryData): ChatEntry {
  return { ...data, id: `e${++entryIdCounter}` };
}

type Listener = () => void;

class ChatStore {
  private entries: ChatEntry[] = [];
  private listeners = new Set<Listener>();

  getEntries(): ChatEntry[] {
    return this.entries;
  }

  /** Replace all entries (used for clear, resume). */
  setEntries(entries: ChatEntry[]): void {
    this.entries = entries;
    this.notify();
  }

  /** Append one entry. */
  append(data: ChatEntryData): void {
    this.entries = [...this.entries, createEntry(data)];
    this.notify();
  }

  /** Functional update — same API as setState(fn). */
  update(fn: (prev: ChatEntry[]) => ChatEntry[]): void {
    this.entries = fn(this.entries);
    this.notify();
  }

  clear(): void {
    this.entries = [];
    this.notify();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/** Singleton store for the chat log. */
export const chatStore = new ChatStore();

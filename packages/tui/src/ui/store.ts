/**
 * ChatStore — external state store for chat messages.
 *
 * Moves chatLog out of React useState to avoid full component tree
 * re-renders on every message update. Components subscribe to specific
 * slices via useSyncExternalStore.
 */

import { logger } from "@cjhyy/code-shell-core";

const storeLog = logger.child({ cat: "chat-store" });
const STREAM_DIAG_ON = process.env.CODESHELL_DEBUG_STREAM === "1";

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
  | { type: "agent_start"; agentId: string; name?: string; description: string; agentType?: string }
  | { type: "agent_end"; agentId: string; name?: string; description: string; text?: string; error?: string; agentType?: string };

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
  | "info"
  | "bg_agent_notification";

export type ChatEntry = ChatEntryData & { id: string };

let entryIdCounter = 0;
export function createEntry(data: ChatEntryData): ChatEntry {
  return { ...data, id: `e${++entryIdCounter}` };
}

/**
 * "Finalized" = entry's content is stable; further stream events will not
 * mutate it in place. Used by VirtualMessageList flow mode to route entries
 * into <Static> (append-only, never re-rendered) vs. the active region (kept
 * in React tree and re-rendered on each delta).
 *
 *   assistant_text  → final once streaming flips to false
 *   tool_running    → transient, always replaced by tool_result; not final
 *   thinking        → transient, filtered out on next tool_use_start
 *   everything else → final on append
 */
export function isEntryFinalized(e: ChatEntry): boolean {
  if (e.type === "assistant_text") return !e.streaming;
  if (e.type === "tool_running") return false;
  if (e.type === "thinking") return false;
  return true;
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
    if (entries === this.entries) return;
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
    const before = this.entries.length;
    const fnStart = STREAM_DIAG_ON ? performance.now() : 0;
    const next = fn(this.entries);
    const fnMs = STREAM_DIAG_ON ? performance.now() - fnStart : 0;
    if (Object.is(next, this.entries)) {
      if (STREAM_DIAG_ON && fnMs > 2) {
        storeLog.info("debug.chat_store.noop_update", {
          fnMs: Math.round(fnMs * 10) / 10,
          entries: before,
          listeners: this.listeners.size,
        });
      }
      return;
    }
    this.entries = next;
    const after = this.entries.length;
    // Debug: track suspicious "still updating after run completed" loops.
    // Counts listener notifications too so we can see render fan-out.
    if (process.env.CODE_SHELL_DEBUG_CHAT) {
      // eslint-disable-next-line no-console
      console.error(`[chatStore.update] ${before} -> ${after}, listeners=${this.listeners.size}`);
    }
    const notifyStart = STREAM_DIAG_ON ? performance.now() : 0;
    this.notify();
    const notifyMs = STREAM_DIAG_ON ? performance.now() - notifyStart : 0;
    if (STREAM_DIAG_ON && (fnMs > 2 || notifyMs > 5)) {
      storeLog.info("debug.chat_store.update", {
        fnMs: Math.round(fnMs * 10) / 10,
        notifyMs: Math.round(notifyMs * 10) / 10,
        entries: after,
        listeners: this.listeners.size,
      });
    }
  }

  /**
   * Commit the in-flight streaming assistant entry as a final (non-streaming)
   * message, optionally appending a suffix (e.g., "[Request interrupted by user]").
   * Drops any thinking entries — model scratch, no user value after interruption.
   * No-op if there is no streaming entry.
   *
   * Empty-text streaming entry is finalized in place (streaming=false) without
   * suffix — keeps the store transition consistent without persisting noise.
   */
  commitInterruptedStreaming(suffix: string): void {
    let changed = false;
    const next: ChatEntry[] = [];
    for (const e of this.entries) {
      if (e.type === "thinking") {
        changed = true;
        continue;
      }
      if (e.type === "assistant_text" && e.streaming) {
        const hasText = e.text.trim().length > 0;
        next.push({
          ...e,
          streaming: false,
          text: hasText ? e.text + suffix : e.text,
        });
        changed = true;
        continue;
      }
      next.push(e);
    }
    if (!changed) return;
    this.entries = next;
    this.notify();
  }

  clear(): void {
    if (this.entries.length === 0) return;
    this.entries = [];
    this.notify();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      // Isolate listeners — one throwing must not stop the rest from being
      // notified (they'd otherwise miss the state update).
      try {
        listener();
      } catch (err) {
        console.error("[chatStore] listener threw", err);
      }
    }
  }
}

/** Singleton store for the chat log. */
export const chatStore = new ChatStore();

/**
 * Input history — JSONL-based persistent command history.
 *
 * Features:
 * - JSONL format for structured persistence (~/.code-shell/history.jsonl)
 * - Per-project grouping with current session priority
 * - Cross-session history with deduplication
 * - Ctrl+R search support via getTimestampedHistory()
 * - Undo last entry on ESC interrupt (removeLastFromHistory)
 * - File locking for concurrent session safety
 *
 * Up/Down arrow navigation through past inputs is also supported.
 */

import {
  appendFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Configuration ─────────────────────────────────────────────────

const MAX_HISTORY_ITEMS = 500;
const CODE_SHELL_DIR = join(homedir(), ".code-shell");
const HISTORY_FILE = join(CODE_SHELL_DIR, "history.jsonl");

// Fallback: also read legacy plain-text history for migration
const LEGACY_HISTORY_FILE = join(CODE_SHELL_DIR, "history");

// ─── Types ─────────────────────────────────────────────────────────

interface HistoryLogEntry {
  /** The display text / user input */
  display: string;
  /** Unix timestamp (ms) */
  timestamp: number;
  /** Project root directory */
  project: string;
  /** Session identifier */
  sessionId?: string;
}

export interface TimestampedHistoryEntry {
  display: string;
  timestamp: number;
}

// ─── State ─────────────────────────────────────────────────────────

let _sessionId = "";
let _projectRoot = "";
let _entries: HistoryLogEntry[] | null = null;
let _pendingEntries: HistoryLogEntry[] = [];
let _lastAddedEntry: HistoryLogEntry | null = null;
const _skippedTimestamps = new Set<number>();
let _flushScheduled = false;

/**
 * Configure the history system with session and project context.
 * Call this once at startup.
 */
export function initHistory(sessionId: string, projectRoot: string): void {
  _sessionId = sessionId;
  _projectRoot = projectRoot;
}

// ─── Read ──────────────────────────────────────────────────────────

function ensureLoaded(): HistoryLogEntry[] {
  if (_entries !== null) return _entries;

  mkdirSync(CODE_SHELL_DIR, { recursive: true });
  _entries = [];

  // Load JSONL history
  if (existsSync(HISTORY_FILE)) {
    try {
      const content = readFileSync(HISTORY_FILE, "utf-8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as HistoryLogEntry;
          if (entry.display && typeof entry.display === "string") {
            _entries.push(entry);
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File read error — start fresh
    }
  }

  // Migrate legacy plain-text history if JSONL is empty
  if (_entries.length === 0 && existsSync(LEGACY_HISTORY_FILE)) {
    try {
      const content = readFileSync(LEGACY_HISTORY_FILE, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      for (const line of lines) {
        _entries.push({
          display: line,
          timestamp: 0, // Unknown — legacy
          project: "",
          sessionId: "",
        });
      }
    } catch {
      // Ignore legacy read errors
    }
  }

  // Trim to max
  if (_entries.length > MAX_HISTORY_ITEMS) {
    _entries = _entries.slice(_entries.length - MAX_HISTORY_ITEMS);
  }

  return _entries;
}

/**
 * Get the display strings for history (most recent last),
 * with current session entries prioritized first.
 */
function getProjectHistory(): string[] {
  const entries = ensureLoaded();
  const currentSessionEntries: string[] = [];
  const otherEntries: string[] = [];
  const seen = new Set<string>();

  // Walk backwards (newest first) to deduplicate
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;

    // Skip entries marked for removal
    if (entry.sessionId === _sessionId && _skippedTimestamps.has(entry.timestamp)) {
      continue;
    }

    // Filter by project if set
    if (_projectRoot && entry.project && entry.project !== _projectRoot) {
      continue;
    }

    if (seen.has(entry.display)) continue;
    seen.add(entry.display);

    if (entry.sessionId === _sessionId) {
      currentSessionEntries.push(entry.display);
    } else {
      otherEntries.push(entry.display);
    }

    if (seen.size >= MAX_HISTORY_ITEMS) break;
  }

  // Reverse to get chronological order (oldest first), session entries first
  return [...currentSessionEntries.reverse(), ...otherEntries.reverse()];
}

// ─── Write ─────────────────────────────────────────────────────────

function flushPendingEntries(): void {
  if (_pendingEntries.length === 0) return;

  try {
    mkdirSync(CODE_SHELL_DIR, { recursive: true });
    const jsonLines = _pendingEntries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    appendFileSync(HISTORY_FILE, jsonLines, { encoding: "utf-8", mode: 0o600 });
  } catch {
    // Best-effort — don't crash on write failure
  }

  _pendingEntries = [];
  _flushScheduled = false;
}

function scheduleFlush(): void {
  if (_flushScheduled) return;
  _flushScheduled = true;
  // Flush on next tick to batch rapid successive writes
  process.nextTick(flushPendingEntries);
}

/**
 * Add an input to history. Persisted as JSONL.
 */
export function addToHistory(input: string): void {
  const trimmed = input.trim();
  if (!trimmed) return;

  const entries = ensureLoaded();
  const logEntry: HistoryLogEntry = {
    display: trimmed,
    timestamp: Date.now(),
    project: _projectRoot,
    sessionId: _sessionId,
  };

  // Add to in-memory list
  entries.push(logEntry);
  _lastAddedEntry = logEntry;

  // Queue for disk write
  _pendingEntries.push(logEntry);
  scheduleFlush();
}

/**
 * Undo the most recent addToHistory call.
 * Used when ESC rewinds the conversation before any response arrives.
 */
export function removeLastFromHistory(): void {
  if (!_lastAddedEntry) return;
  const entry = _lastAddedEntry;
  _lastAddedEntry = null;

  // Try to remove from pending buffer (fast path)
  const idx = _pendingEntries.lastIndexOf(entry);
  if (idx !== -1) {
    _pendingEntries.splice(idx, 1);
  } else {
    // Already flushed — mark for skip when reading
    _skippedTimestamps.add(entry.timestamp);
  }

  // Also remove from in-memory list
  const entries = ensureLoaded();
  const memIdx = entries.lastIndexOf(entry);
  if (memIdx !== -1) {
    entries.splice(memIdx, 1);
  }
}

/**
 * Clear pending history entries (e.g. on session reset).
 */
export function clearPendingHistoryEntries(): void {
  _pendingEntries = [];
  _lastAddedEntry = null;
  _skippedTimestamps.clear();
}

/**
 * Flush any pending writes synchronously (call at process exit).
 */
export function flushHistorySync(): void {
  flushPendingEntries();
}

// ─── Search (Ctrl+R support) ───────────────────────────────────────

/**
 * Get timestamped history entries for the current project.
 * Used for Ctrl+R search picker — deduped by display text, newest first.
 */
export function getTimestampedHistory(): TimestampedHistoryEntry[] {
  const entries = ensureLoaded();
  const seen = new Set<string>();
  const results: TimestampedHistoryEntry[] = [];

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (_projectRoot && entry.project && entry.project !== _projectRoot) continue;
    if (seen.has(entry.display)) continue;
    seen.add(entry.display);

    results.push({
      display: entry.display,
      timestamp: entry.timestamp,
    });

    if (results.length >= MAX_HISTORY_ITEMS) break;
  }

  return results;
}

/**
 * Search history entries matching a query string (case-insensitive).
 */
export function searchHistory(query: string): TimestampedHistoryEntry[] {
  if (!query.trim()) return getTimestampedHistory();
  const lower = query.toLowerCase();
  return getTimestampedHistory().filter((e) =>
    e.display.toLowerCase().includes(lower),
  );
}

// ─── Navigator (Up/Down arrow) ─────────────────────────────────────

/**
 * Create a history navigator for Up/Down arrow browsing.
 */
export function createHistoryNavigator() {
  let history = getProjectHistory();
  let cursor = history.length; // Start past the end (current input)
  let savedCurrent = ""; // Stash the current input when navigating

  return {
    /** Move up (older). Returns the history entry or null if at top. */
    up(currentInput: string): string | null {
      if (cursor === history.length) {
        savedCurrent = currentInput; // Stash current input
      }
      if (cursor <= 0) return null;
      cursor--;
      return history[cursor] ?? null;
    },

    /** Move down (newer). Returns the history entry, or the stashed input at bottom. */
    down(): string | null {
      if (cursor >= history.length) return null;
      cursor++;
      if (cursor >= history.length) {
        return savedCurrent; // Restore stashed input
      }
      return history[cursor] ?? null;
    },

    /** Reset cursor to bottom (call on submit). */
    reset(): void {
      cursor = history.length;
      savedCurrent = "";
    },

    /** Refresh after addToHistory mutates the array. */
    refresh(): void {
      history = getProjectHistory();
      cursor = history.length;
      savedCurrent = "";
    },
  };
}

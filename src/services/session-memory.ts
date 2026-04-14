/**
 * Session Memory service — automatic session memory maintenance.
 *
 * Extracts and maintains conversation context as persistent memory
 * entries that survive across sessions.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface SessionMemoryEntry {
  sessionId: string;
  summary: string;
  keyTopics: string[];
  decisions: string[];
  createdAt: string;
  tokenCount?: number;
}

const MEMORY_DIR = join(homedir(), ".code-shell", "session-memories");

/**
 * Save a session memory entry.
 */
export function saveSessionMemory(entry: SessionMemoryEntry): void {
  mkdirSync(MEMORY_DIR, { recursive: true });
  const file = join(MEMORY_DIR, `${entry.sessionId}.json`);
  writeFileSync(file, JSON.stringify(entry, null, 2), "utf-8");
}

/**
 * Load a session memory by session ID.
 */
export function loadSessionMemory(sessionId: string): SessionMemoryEntry | null {
  const file = join(MEMORY_DIR, `${sessionId}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * List all session memories, most recent first.
 */
export function listSessionMemories(limit = 50): SessionMemoryEntry[] {
  if (!existsSync(MEMORY_DIR)) return [];

  const files = readdirSync(MEMORY_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, limit);

  const entries: SessionMemoryEntry[] = [];
  for (const file of files) {
    try {
      const entry = JSON.parse(readFileSync(join(MEMORY_DIR, file), "utf-8"));
      entries.push(entry);
    } catch {}
  }
  return entries;
}

/**
 * Search session memories by keyword.
 */
export function searchSessionMemories(query: string): SessionMemoryEntry[] {
  const all = listSessionMemories(200);
  const q = query.toLowerCase();

  return all.filter(
    (m) =>
      m.summary.toLowerCase().includes(q) ||
      m.keyTopics.some((t) => t.toLowerCase().includes(q)) ||
      m.decisions.some((d) => d.toLowerCase().includes(q)),
  );
}

/**
 * Build a prompt for extracting session memory from a conversation.
 */
export function buildSessionMemoryPrompt(
  messages: Array<{ role: string; content: string }>,
): string {
  const text = messages
    .map((m) => `[${m.role}]: ${m.content.slice(0, 2000)}`)
    .join("\n\n");

  return `Extract a concise session memory from this conversation:

${text.slice(0, 30000)}

Respond with JSON:
{
  "summary": "One paragraph summarizing what was discussed and accomplished",
  "keyTopics": ["topic1", "topic2", ...],
  "decisions": ["decision1", "decision2", ...]
}`;
}

/**
 * Session Memory service — automatic session memory maintenance.
 *
 * Extracts and maintains conversation context as persistent memory
 * entries that survive across sessions.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { userHome } from "../settings/manager.js";
import { sortSessionMemoriesByRecency } from "./session-memory-sort.js";

export interface SessionMemoryEntry {
  sessionId: string;
  summary: string;
  keyTopics: string[];
  decisions: string[];
  createdAt: string;
  tokenCount?: number;
}

// Resolve per-call (NOT a module const): userHome() reads $HOME live, so a
// relocated/test HOME redirects writes instead of pinning the real ~/.code-shell
// at import time (bun freezes a module-level homedir() and never re-reads it).
// `baseDir` is the explicit injection point (the `~/.code-shell`-equivalent
// root): when provided it wins over $HOME resolution — identity-scoped server
// deployments pass their per-user data root here.
function memoryDir(baseDir?: string): string {
  return join(baseDir ?? join(userHome(), ".code-shell"), "session-memories");
}

/**
 * Save a session memory entry.
 */
export function saveSessionMemory(entry: SessionMemoryEntry, baseDir?: string): void {
  const dir = memoryDir(baseDir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${entry.sessionId}.json`);
  writeFileSync(file, JSON.stringify(entry, null, 2), "utf-8");
}

/**
 * Load a session memory by session ID.
 */
export function loadSessionMemory(sessionId: string, baseDir?: string): SessionMemoryEntry | null {
  const file = join(memoryDir(baseDir), `${sessionId}.json`);
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
export function listSessionMemories(limit = 50, baseDir?: string): SessionMemoryEntry[] {
  const dir = memoryDir(baseDir);
  if (!existsSync(dir)) return [];

  // Read all entries, then order by createdAt (not by filename — the filename
  // is the sessionId, which has no chronological meaning), then take `limit`.
  const entries: SessionMemoryEntry[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      entries.push(JSON.parse(readFileSync(join(dir, file), "utf-8")));
    } catch {
      /* intentional: skip a corrupt/torn memory file rather than failing the
         whole listing — one bad entry must not hide all the others. */
    }
  }
  return sortSessionMemoriesByRecency(entries).slice(0, limit);
}

/**
 * Search session memories by keyword.
 */
export function searchSessionMemories(query: string, baseDir?: string): SessionMemoryEntry[] {
  const all = listSessionMemories(200, baseDir);
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

Respond with ONLY a single JSON object — no markdown code fence, no text before
or after. Keep every value on one line (escape any newline as \\n) and escape
any double quote inside a string as \\". Shape:
{
  "summary": "One paragraph summarizing what was discussed and accomplished",
  "keyTopics": ["topic1", "topic2"],
  "decisions": ["decision1", "decision2"]
}`;
}

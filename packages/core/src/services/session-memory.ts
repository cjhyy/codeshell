/**
 * Session Memory service — automatic session memory maintenance.
 *
 * Extracts and maintains conversation context as persistent memory
 * entries that survive across sessions.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const MAX_MEMORY_FILE_BYTES = 1024 * 1024;
const MAX_MEMORY_ENTRIES = 20_000;
const MAX_MEMORY_LIST_ITEMS = 1_000;

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
  assertSessionMemoryEntry(entry);
  ensureRealMemoryDirectory(dir);
  const file = join(dir, `${entry.sessionId}.json`);
  assertSafeMemoryTarget(file);
  const serialized = JSON.stringify(entry, null, 2);
  if (Buffer.byteLength(serialized, "utf8") > MAX_MEMORY_FILE_BYTES) {
    throw new Error("session memory is too large");
  }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Load a session memory by session ID.
 */
export function loadSessionMemory(sessionId: string, baseDir?: string): SessionMemoryEntry | null {
  if (!validSessionId(sessionId)) return null;
  const file = join(memoryDir(baseDir), `${sessionId}.json`);
  if (!existsSync(file)) return null;
  let fd: number | undefined;
  try {
    const dirInfo = lstatSync(memoryDir(baseDir));
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) return null;
    const entry = lstatSync(file);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.size > MAX_MEMORY_FILE_BYTES) return null;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_MEMORY_FILE_BYTES) return null;
    const parsed = JSON.parse(readFileSync(fd, "utf-8")) as unknown;
    return validSessionMemoryEntry(parsed) && parsed.sessionId === sessionId ? parsed : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * List all session memories, most recent first.
 */
export function listSessionMemories(limit = 50, baseDir?: string): SessionMemoryEntry[] {
  const dir = memoryDir(baseDir);
  if (!existsSync(dir)) return [];
  try {
    const info = lstatSync(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) return [];
  } catch {
    return [];
  }

  // Read all entries, then order by createdAt (not by filename — the filename
  // is the sessionId, which has no chronological meaning), then take `limit`.
  const entries: SessionMemoryEntry[] = [];
  const files = readdirSync(dir, { withFileTypes: true });
  if (files.length > MAX_MEMORY_ENTRIES) return [];
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".json")) continue;
    const sessionId = file.name.slice(0, -5);
    if (!validSessionId(sessionId)) continue;
    try {
      const entry = loadSessionMemory(sessionId, baseDir);
      if (entry) entries.push(entry);
    } catch {
      /* intentional: skip a corrupt/torn memory file rather than failing the
         whole listing — one bad entry must not hide all the others. */
    }
  }
  const safeLimit =
    Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_MEMORY_LIST_ITEMS) : 0;
  return sortSessionMemoriesByRecency(entries).slice(0, safeLimit);
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_RE.test(value) && value !== "." && value !== "..";
}

function validSessionMemoryEntry(value: unknown): value is SessionMemoryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<SessionMemoryEntry>;
  return (
    validSessionId(entry.sessionId) &&
    typeof entry.summary === "string" &&
    entry.summary.length <= 100_000 &&
    validMemoryStringList(entry.keyTopics) &&
    validMemoryStringList(entry.decisions) &&
    typeof entry.createdAt === "string" &&
    entry.createdAt.length <= 64 &&
    Number.isFinite(Date.parse(entry.createdAt)) &&
    (entry.tokenCount === undefined ||
      (Number.isSafeInteger(entry.tokenCount) && entry.tokenCount >= 0 && entry.tokenCount <= 10_000_000))
  );
}

function validMemoryStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 1_000 &&
    value.every((item) => typeof item === "string" && item.length <= 4_096 && !item.includes("\0"))
  );
}

function assertSessionMemoryEntry(entry: SessionMemoryEntry): void {
  if (!validSessionMemoryEntry(entry)) throw new Error("invalid session memory entry");
}

function ensureRealMemoryDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("session memory directory must be a real directory");
  }
}

function assertSafeMemoryTarget(file: string): void {
  try {
    const info = lstatSync(file);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("session memory target must be a regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
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

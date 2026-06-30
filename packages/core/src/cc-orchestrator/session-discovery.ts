import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Encode a cwd to claude's project dir name: every non-[A-Za-z0-9] char → '-'.
 *  Mirrors `~/.claude/projects/<encoded>` (verified against real layout). */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export interface DiscoveredSession {
  sessionId: string;
  firstMessage: string;
  lastModified: number;
  messageCount: number;
}

/**
 * Bound how many sessions a discovery scan deep-reads + returns. Without this,
 * `discoverSessions` read EVERY `.jsonl` file fully (title + message count) on
 * every list open — O(all history) work that makes the CC/Codex room list slow
 * and unwieldy once a project accumulates sessions. The default surfaces only
 * the recent, useful slice; the UI fetches older ones on demand by passing a
 * larger `limit` (or `sinceMs: 0`).
 */
export interface DiscoverOptions {
  /** Max sessions to return (after the recency filter), newest first.
   *  undefined or <= 0 = no cap. */
  limit?: number;
  /** Only include sessions modified within this many ms of `now`.
   *  undefined or <= 0 = no window. */
  sinceMs?: number;
  /** Injectable clock for tests. Defaults to Date.now(). */
  now?: number;
}

/** Default room-list window: last 2 weeks AND at most 20 — the intersection. */
export const DEFAULT_DISCOVER_LIMIT = 20;
export const DEFAULT_DISCOVER_SINCE_MS = 14 * 24 * 60 * 60 * 1000;

function claudeProjectsDir(claudeHome: string): string {
  return join(claudeHome, "projects");
}

/** Extract first *real* user message text, skipping caveat/command noise. */
function firstUserMessage(lines: string[]): string {
  for (const line of lines) {
    if (!line.trim()) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== "user") continue;
    const c = d.message?.content;
    const text = typeof c === "string"
      ? c
      : Array.isArray(c)
        ? c.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("")
        : "";
    const t = text.trim();
    if (!t) continue;
    if (t.startsWith("<local-command-caveat>") || t.startsWith("<command-name>")) continue;
    return t.slice(0, 200);
  }
  return "";
}

function countUserMessages(lines: string[]): number {
  let n = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try { if (JSON.parse(line).type === "user") n++; } catch { /* skip */ }
  }
  return n;
}

/** Cheap (sessionId, mtime) pairs for every session file — stat only, no read. */
function listSessionStats(dir: string): { sessionId: string; file: string; mtimeMs: number }[] {
  const stats: { sessionId: string; file: string; mtimeMs: number }[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = join(dir, name);
    let st;
    try { st = statSync(file); } catch { continue; }
    stats.push({ sessionId: name.replace(/\.jsonl$/, ""), file, mtimeMs: st.mtimeMs });
  }
  return stats;
}

/**
 * Apply the recency window + limit to mtime-sorted stats, returning the slice to
 * deep-read. Shared by the claude + codex discovery paths so they bound work
 * identically. `total` (caller-side) lets the UI show a "load more" affordance.
 */
export function selectRecentStats<T extends { mtimeMs: number }>(
  stats: T[],
  opts: DiscoverOptions = {},
): T[] {
  const now = opts.now ?? Date.now();
  let sel = stats.slice().sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (opts.sinceMs && opts.sinceMs > 0) {
    const cutoff = now - opts.sinceMs;
    sel = sel.filter((s) => s.mtimeMs >= cutoff);
  }
  if (opts.limit && opts.limit > 0) sel = sel.slice(0, opts.limit);
  return sel;
}

/** List claude sessions for `cwd`. `claudeHome` defaults to ~/.claude (override
 *  for tests). Read-only, on-demand scan; no index. Stats every file cheaply,
 *  then deep-reads (title + count) ONLY the recent slice (opts) so an old,
 *  large history doesn't get fully read on every list open. */
export function discoverSessions(
  cwd: string,
  claudeHome = join(homedir(), ".claude"),
  opts: DiscoverOptions = {},
): DiscoveredSession[] {
  const dir = join(claudeProjectsDir(claudeHome), encodeCwd(cwd));
  if (!existsSync(dir)) return [];
  const selected = selectRecentStats(listSessionStats(dir), opts);
  const out: DiscoveredSession[] = [];
  for (const s of selected) {
    let lines: string[];
    try { lines = readFileSync(s.file, "utf-8").split("\n"); } catch { continue; }
    out.push({
      sessionId: s.sessionId,
      firstMessage: firstUserMessage(lines),
      lastModified: s.mtimeMs,
      messageCount: countUserMessages(lines),
    });
  }
  return out;
}

/** Count of all session files for `cwd`, cheaply (stat only). Lets the UI know
 *  whether a bounded `discoverSessions` left older sessions unshown. */
export function countSessions(cwd: string, claudeHome = join(homedir(), ".claude")): number {
  const dir = join(claudeProjectsDir(claudeHome), encodeCwd(cwd));
  if (!existsSync(dir)) return 0;
  return listSessionStats(dir).length;
}

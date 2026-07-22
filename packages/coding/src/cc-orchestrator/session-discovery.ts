import {
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

/** Encode a cwd to claude's project dir name: every non-[A-Za-z0-9] char → '-'.
 *  Mirrors `~/.claude/projects/<encoded>` (verified against real layout). */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** Session discovered from an external coding CLI. */
export interface DiscoveredSession {
  sessionId: string;
  /** The cwd recorded by the external CLI for this session. Consumers must
   *  open/resume the session with this path instead of assuming the currently
   *  selected CodeShell project has the same cwd (DriveAgent worktrees often
   *  do not). */
  cwd: string;
  firstMessage: string;
  lastModified: number;
  messageCount: number;
}

/** A session discovered globally from an external CLI's own storage, with the
 *  file path so the Pet adapter can tail it. Shared by codex + claude paths. */
export interface RecentExternalSession {
  sessionId: string;
  cwd: string;
  file: string;
  lastModified: number;
  firstMessage: string;
}

/** One registered CodeShell project root and its effective visibility. */
export interface ExternalSessionProjectRoot {
  cwd: string;
  enabled: boolean;
}

/**
 * Source-level discovery scope. Registered roots use longest-ancestor matching;
 * sessions outside every registered root follow includeUnregistered (the user
 * global baseline).
 */
export interface ExternalSessionDiscoveryScope {
  includeUnregistered: boolean;
  projectRoots: readonly ExternalSessionProjectRoot[];
}

/** Resolve aliases such as a trailing slash before comparing project roots. */
export function normalizeExternalSessionCwd(cwd: string): string {
  return resolve(cwd);
}

function isWithinRoot(cwd: string, root: string): boolean {
  const child = relative(root, cwd);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

/** Pick the most specific registered ancestor for a session cwd. */
export function externalSessionProjectRootFor(
  cwd: string,
  roots: readonly ExternalSessionProjectRoot[],
): ExternalSessionProjectRoot | undefined {
  const normalizedCwd = normalizeExternalSessionCwd(cwd);
  let best: ExternalSessionProjectRoot | undefined;
  for (const candidate of roots) {
    const normalizedRoot = normalizeExternalSessionCwd(candidate.cwd);
    if (!isWithinRoot(normalizedCwd, normalizedRoot)) continue;
    if (!best || normalizedRoot.length > normalizeExternalSessionCwd(best.cwd).length) {
      best = { ...candidate, cwd: normalizedRoot };
    }
  }
  return best;
}

/** Apply a discovery scope to one real cwd. */
export function externalSessionCwdEnabled(
  cwd: string,
  scope?: ExternalSessionDiscoveryScope,
): boolean {
  if (!scope) return true;
  return (
    externalSessionProjectRootFor(cwd, scope.projectRoots)?.enabled ?? scope.includeUnregistered
  );
}

/**
 * Cheap Claude-directory prefilter. Because encodeCwd is lossy, true only means
 * "this directory may contain an enabled cwd". The real cwd identity is always
 * checked before transcript content is read.
 */
export function claudeProjectDirEnabled(
  encodedProjectDir: string,
  scope?: ExternalSessionDiscoveryScope,
): boolean {
  if (!scope) return true;
  // With an enabled unregistered baseline, an encoded name can never prove a
  // directory is disabled: `/work/repo-other` looks like a descendant of
  // `/work/repo`, and `/foo-bar` collides exactly with `/foo/bar`. Probe only
  // the small identity prefix and decide from the real cwd later.
  if (scope.includeUnregistered) return true;
  return scope.projectRoots.some((candidate) => {
    if (!candidate.enabled) return false;
    const normalizedRoot = normalizeExternalSessionCwd(candidate.cwd);
    const exact = encodeCwd(normalizedRoot);
    const descendantPrefix = encodeCwd(
      normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`,
    );
    return encodedProjectDir === exact || encodedProjectDir.startsWith(descendantPrefix);
  });
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
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type !== "user") continue;
    const c = d.message?.content;
    const text =
      typeof c === "string"
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
    try {
      if (JSON.parse(line).type === "user") n++;
    } catch {
      /* skip */
    }
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
    try {
      st = statSync(file);
    } catch {
      continue;
    }
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
    try {
      lines = readFileSync(s.file, "utf-8").split("\n");
    } catch {
      continue;
    }
    out.push({
      sessionId: s.sessionId,
      cwd,
      firstMessage: firstUserMessage(lines),
      lastModified: s.mtimeMs,
      messageCount: countUserMessages(lines),
    });
  }
  return out;
}

/** Read up to maxBytes of a file as UTF-8 (may span many lines), without
 *  loading the whole transcript. Newlines are preserved so callers can split. */
function readBoundedPrefix(file: string, maxBytes: number): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString("utf-8", 0, n);
  } finally {
    closeSync(fd);
  }
}

/**
 * Read only enough of the first line to recover Claude's top-level cwd
 * identity. The field precedes message content in Claude's records; if a
 * nonstandard record puts it after a large payload, fail closed instead of
 * reading transcript content merely to classify visibility.
 */
function readSessionIdentityCwd(file: string, maxBytes = 4 * 1024): string | undefined {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    let total = 0;
    while (total < maxBytes) {
      const read = readSync(fd, buffer, total, Math.min(256, maxBytes - total), total);
      if (read === 0) return undefined;
      total += read;
      const text = buffer.subarray(0, total).toString("utf-8");
      const newline = text.indexOf("\n");
      const firstLine = newline >= 0 ? text.slice(0, newline) : text;
      const cwdIndex = firstLine.indexOf('"cwd"');
      const messageIndex = firstLine.indexOf('"message"');
      if (messageIndex >= 0 && (cwdIndex < 0 || cwdIndex > messageIndex)) return undefined;
      if (cwdIndex < 0) {
        if (newline >= 0) return undefined;
        continue;
      }
      const match = firstLine.slice(cwdIndex).match(/^"cwd"\s*:\s*("(?:\\.|[^"\\])*")/);
      if (!match) continue;
      try {
        const cwd = JSON.parse(match[1]!) as unknown;
        return typeof cwd === "string" ? cwd : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

export interface ClaudeSessionDiscoveryDiagnostics {
  /** Called immediately before the 1 MiB title/content prefix is read. */
  onContentRead?: (file: string) => void;
}

/**
 * Discover ALL recent Claude Code sessions across every project dir. Claude
 * encodes cwd into the dir name lossily (encodeCwd), so the real cwd comes from
 * the session file's first-line `cwd` field. After the stat/recency pass, read a
 * small identity prefix first and apply scope. Only enabled identities receive
 * the larger bounded content read used to find the card title.
 */
export function discoverRecentClaudeSessions(
  opts: DiscoverOptions = {},
  claudeHome = join(homedir(), ".claude"),
  scope?: ExternalSessionDiscoveryScope,
  diagnostics?: ClaudeSessionDiscoveryDiagnostics,
): RecentExternalSession[] {
  const projects = claudeProjectsDir(claudeHome);
  if (!existsSync(projects)) return [];
  const stats: { file: string; sessionId: string; mtimeMs: number }[] = [];
  for (const projectDir of readdirSync(projects)) {
    // Skip directories that cannot contain an enabled root. Ambiguous lossy
    // names proceed only to the small per-file identity read below.
    if (!claudeProjectDirEnabled(projectDir, scope)) continue;
    const dir = join(projects, projectDir);
    let dirStat;
    try {
      dirStat = statSync(dir);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;
    for (const entry of listSessionStats(dir)) {
      stats.push({ file: entry.file, sessionId: entry.sessionId, mtimeMs: entry.mtimeMs });
    }
  }
  const windowed = selectRecentStats(stats, { sinceMs: opts.sinceMs, now: opts.now });
  const limit = opts.limit && opts.limit > 0 ? opts.limit : Infinity;
  const out: RecentExternalSession[] = [];
  for (const s of windowed) {
    if (out.length >= limit) break;
    let cwd: string | undefined;
    try {
      cwd = readSessionIdentityCwd(s.file);
    } catch {
      continue;
    }
    if (!cwd || !externalSessionCwdEnabled(cwd, scope)) continue;
    let firstMessage = "";
    try {
      diagnostics?.onContentRead?.(s.file);
      firstMessage = firstUserMessage(readBoundedPrefix(s.file, 1 << 20).split("\n"));
    } catch {
      continue;
    }
    out.push({ sessionId: s.sessionId, cwd, file: s.file, lastModified: s.mtimeMs, firstMessage });
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

import { readdirSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  DiscoveredSession,
  DiscoverOptions,
  ExternalSessionDiscoveryScope,
  RecentExternalSession,
} from "./session-discovery.js";
import { externalSessionCwdEnabled, selectRecentStats } from "./session-discovery.js";
import { codexUserText } from "./codex-user-text.js";

export interface CodexSessionList {
  sessions: DiscoveredSession[];
  total: number;
}

/** Interactive room lists must not run the synchronous rollout walk on the
 * host event loop. Read identities once for both the list and its total, then
 * read titles only for the selected, deduplicated threads. */
export async function listCodexSessionsForCwds(
  cwds: readonly string[],
  codexHome = join(homedir(), ".codex"),
  opts: DiscoverOptions = {},
  accept?: (session: { sessionId: string; cwd: string }) => boolean,
): Promise<CodexSessionList> {
  const cwdSet = new Set(cwds);
  if (cwdSet.size === 0) return { sessions: [], total: 0 };
  const files = await listRolloutsAsync(join(codexHome, "sessions"));
  const matches = await mapConcurrent(files, async (file) => {
    try {
      const [info, firstLine] = await Promise.all([stat(file), readFirstLineAsync(file)]);
      const meta = parseSessionMeta(firstLine);
      if (!meta?.id || !meta.cwd || !cwdSet.has(meta.cwd)) return undefined;
      if (accept && !accept({ sessionId: meta.id, cwd: meta.cwd })) return undefined;
      return { file, mtimeMs: info.mtimeMs, sessionId: meta.id, cwd: meta.cwd };
    } catch {
      // Rollouts can disappear or still have a partial first line during a scan.
      return undefined;
    }
  });
  const byThread = new Map<string, NonNullable<(typeof matches)[number]>>();
  for (const match of matches) {
    if (!match) continue;
    const prior = byThread.get(match.sessionId);
    if (!prior || match.mtimeMs > prior.mtimeMs) byThread.set(match.sessionId, match);
  }
  const selected = selectRecentStats([...byThread.values()], opts);
  const sessions = await mapConcurrent(selected, async (session): Promise<DiscoveredSession> => {
    let firstMessage = "";
    try {
      firstMessage = firstUserMessageFromPrefix(await readPrefixAsync(session.file, 1 << 20));
    } catch {
      // Retain the session identity if its title cannot be read.
    }
    return {
      sessionId: session.sessionId,
      cwd: session.cwd,
      firstMessage,
      lastModified: session.mtimeMs,
      messageCount: 0,
    };
  });
  return { sessions, total: byThread.size };
}

/** Dirents avoid statting every directory and every file twice. Do not follow
 * directory symlinks: a cyclic link must not make interactive discovery hang. */
async function listRolloutsAsync(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const file = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listRolloutsAsync(file)));
    else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      files.push(file);
    }
  }
  return files;
}

/** Bound open file handles and prefix buffers even for a large history. */
async function mapConcurrent<T, R>(
  items: readonly T[],
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(16, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await map(items[index]);
      }
    }),
  );
  return results;
}

async function readPrefixAsync(file: string, maxBytes: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.toString("utf-8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Most metadata fits in one 4 KiB read. Grow only for a longer first line,
 * preserving the existing 64 KiB identity bound without reading transcript
 * prefixes merely to count threads. */
async function readFirstLineAsync(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const chunks: Buffer[] = [];
    for (let position = 0; position < 1 << 16; position += 4096) {
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(10);
      chunks.push(newline === -1 ? chunk : chunk.subarray(0, newline));
      if (newline !== -1 || bytesRead < buffer.length) break;
    }
    return Buffer.concat(chunks).toString("utf-8");
  } finally {
    await handle.close();
  }
}

/**
 * Discover codex CLI sessions for a given `cwd`, mirroring the claude-side
 * `discoverSessions` but for codex's storage layout, which is fundamentally
 * different:
 *
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *
 * Unlike claude (one dir per project), codex stores rollouts by DATE, not by
 * cwd. The cwd lives INSIDE the file: the first line is a `session_meta` event
 * whose `payload` carries `{ id, cwd, timestamp }` (`id` is the thread id we
 * resume by). So discovery means: walk every rollout file, read just its first
 * line to learn its cwd, and keep the ones matching the requested project.
 *
 * Codex rollout files can be large, so we deliberately AVOID `readFileSync` on
 * the whole file (the claude version reads the whole file because claude
 * sessions are small). We read the first line for the meta, and — only for a
 * matching file — read a bounded prefix to find the first real user message for
 * the title. Returns the same `DiscoveredSession` shape so the UI is CLI-blind.
 */
/** Discover Codex CLI sessions for the coding host. */
export function discoverCodexSessions(
  cwd: string,
  codexHome = join(homedir(), ".codex"),
  opts: DiscoverOptions = {},
): DiscoveredSession[] {
  return discoverCodexSessionsForCwds([cwd], codexHome, opts);
}

/** Discover several cwd buckets in one rollout walk. This matters for the
 * room list: a CodeShell project and the worktrees delegated from it are one
 * user-visible scope, while Codex stores all of them in a single global tree. */
export function discoverCodexSessionsForCwds(
  cwds: readonly string[],
  codexHome = join(homedir(), ".codex"),
  opts: DiscoverOptions = {},
  accept?: (session: { sessionId: string; cwd: string }) => boolean,
): DiscoveredSession[] {
  const root = join(codexHome, "sessions");
  if (!existsSync(root)) return [];
  const cwdSet = new Set(cwds);
  if (cwdSet.size === 0) return [];

  // Cheap pass: stat every rollout (no read). Apply the recency window here so
  // the meta read (first line) only runs on in-window files. The limit can't be
  // applied yet — we don't know which files match `cwd` until we read the meta,
  // so we'd otherwise drop matching-but-not-yet-seen sessions.
  const windowed = selectRecentStats(statAllRollouts(root), {
    sinceMs: opts.sinceMs,
    now: opts.now,
  });

  const limit = opts.limit && opts.limit > 0 ? opts.limit : Infinity;
  const out: DiscoveredSession[] = [];
  for (const s of windowed) {
    if (out.length >= limit) break;
    let meta: { id?: string; cwd?: string } | undefined;
    try {
      meta = readSessionMeta(s.file);
    } catch {
      continue;
    }
    if (!meta || !meta.id || !meta.cwd || !cwdSet.has(meta.cwd)) continue;
    if (accept && !accept({ sessionId: meta.id, cwd: meta.cwd })) continue;
    out.push({
      sessionId: meta.id,
      cwd: meta.cwd,
      firstMessage: readFirstUserMessage(s.file),
      lastModified: s.mtimeMs,
      messageCount: 0, // not tracked for codex (would need a full scan); UI shows time + title.
    });
  }
  return out;
}

/** Count codex sessions for `cwd` (reads first-line meta of every rollout; no
 *  window). Used so the UI knows whether a bounded list left older ones hidden. */
export function countCodexSessions(cwd: string, codexHome = join(homedir(), ".codex")): number {
  return countCodexSessionsForCwds([cwd], codexHome);
}

export function countCodexSessionsForCwds(
  cwds: readonly string[],
  codexHome = join(homedir(), ".codex"),
): number {
  const root = join(codexHome, "sessions");
  if (!existsSync(root)) return 0;
  const cwdSet = new Set(cwds);
  let n = 0;
  for (const file of walkRollouts(root)) {
    let meta: { id?: string; cwd?: string } | undefined;
    try {
      meta = readSessionMeta(file);
    } catch {
      continue;
    }
    if (meta && meta.id && meta.cwd && cwdSet.has(meta.cwd)) n++;
  }
  return n;
}

/** One Codex session discovered globally (no cwd filter), for the Pet
 *  external-session adapter. `file` is the newest rollout for this thread.
 *  Alias of the shared shape so codex + claude paths stay isomorphic. */
export type RecentCodexSession = RecentExternalSession;

/**
 * Discover ALL recent codex sessions regardless of cwd. Same bounded-read
 * strategy as `discoverCodexSessionsForCwds` (stat pass → recency window →
 * first-line meta), plus per-thread dedup: a resumed thread appends a NEW
 * rollout file with the same session_meta id, so keep only the newest file
 * (windowed list is already mtime-descending — first hit wins).
 */
export function discoverRecentCodexSessions(
  opts: DiscoverOptions = {},
  codexHome = join(homedir(), ".codex"),
  scope?: ExternalSessionDiscoveryScope,
): RecentCodexSession[] {
  const root = join(codexHome, "sessions");
  if (!existsSync(root)) return [];
  const windowed = selectRecentStats(statAllRollouts(root), {
    sinceMs: opts.sinceMs,
    now: opts.now,
  });
  const limit = opts.limit && opts.limit > 0 ? opts.limit : Infinity;
  const out = new Map<string, RecentCodexSession>();
  for (const s of windowed) {
    if (out.size >= limit) break;
    let meta: { id?: string; cwd?: string } | undefined;
    try {
      // Codex stores every cwd in one date-partitioned tree, so the bounded
      // first-line session_meta is the earliest possible project boundary.
      // Apply scope immediately here: a disabled root is never title/content
      // probed, returned to the adapter, or tailed.
      meta = readSessionMeta(s.file);
    } catch {
      continue;
    }
    if (!meta?.id || !meta.cwd || out.has(meta.id) || !externalSessionCwdEnabled(meta.cwd, scope)) {
      continue;
    }
    out.set(meta.id, {
      sessionId: meta.id,
      cwd: meta.cwd,
      file: s.file,
      lastModified: s.mtimeMs,
      firstMessage: readFirstUserMessage(s.file),
    });
  }
  return [...out.values()];
}

/** Stat every rollout under <root>/sessions, skipping unreadable files. */
function statAllRollouts(root: string): { file: string; mtimeMs: number }[] {
  const stats: { file: string; mtimeMs: number }[] = [];
  for (const file of walkRollouts(root)) {
    try {
      stats.push({ file, mtimeMs: statSync(file).mtimeMs });
    } catch {
      continue;
    }
  }
  return stats;
}

/** Recursively yield every `rollout-*.jsonl` file under `root`. */
function* walkRollouts(root: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(root, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walkRollouts(full);
    } else if (name.startsWith("rollout-") && name.endsWith(".jsonl")) {
      yield full;
    }
  }
}

/** Read just the first line of a file (bounded), without loading the whole file. */
function readFirstLine(file: string, maxBytes = 1 << 16): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    const text = buf.toString("utf-8", 0, n);
    const nl = text.indexOf("\n");
    return nl === -1 ? text : text.slice(0, nl);
  } finally {
    closeSync(fd);
  }
}

/** Parse the first-line `session_meta` event → `{ id, cwd }`. */
function readSessionMeta(file: string): { id?: string; cwd?: string } | undefined {
  return parseSessionMeta(readFirstLine(file));
}

function parseSessionMeta(line: string): { id?: string; cwd?: string } | undefined {
  const first = line.trim();
  if (!first) return undefined;
  const d = JSON.parse(first) as { type?: string; payload?: { id?: string; cwd?: string } };
  if (d.type !== "session_meta" || !d.payload) return undefined;
  return { id: d.payload.id, cwd: d.payload.cwd };
}

/**
 * Find the first *real* user message text for the session title. Codex user
 * messages look like:
 *   {type:"response_item", payload:{type:"message", role:"user",
 *      content:[{type:"input_text", text}]}}
 * A user message can contain several parts: host-injected plugin/AGENTS/env
 * context followed by the actual prompt. `codexUserText` drops the injected
 * parts without discarding the prompt beside them.
 *
 * Reads a bounded prefix of the file rather than the whole thing.
 */
function readFirstUserMessage(file: string, maxBytes = 1 << 20): string {
  let chunk: string;
  try {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const n = readSync(fd, buf, 0, maxBytes, 0);
      chunk = buf.toString("utf-8", 0, n);
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
  return firstUserMessageFromPrefix(chunk);
}

function firstUserMessageFromPrefix(chunk: string): string {
  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      // Truncated last line of the bounded read — stop scanning.
      break;
    }
    const p = d?.payload;
    if (d?.type !== "response_item" || p?.type !== "message" || p?.role !== "user") continue;
    const t = codexUserText(p.content).trim();
    if (!t) continue;
    return t.slice(0, 200);
  }
  return "";
}

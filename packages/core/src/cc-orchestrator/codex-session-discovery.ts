import { readdirSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { DiscoveredSession, DiscoverOptions } from "./session-discovery.js";
import { selectRecentStats } from "./session-discovery.js";

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
export function discoverCodexSessions(
  cwd: string,
  codexHome = join(homedir(), ".codex"),
  opts: DiscoverOptions = {},
): DiscoveredSession[] {
  const root = join(codexHome, "sessions");
  if (!existsSync(root)) return [];

  // Cheap pass: stat every rollout (no read). Apply the recency window here so
  // the meta read (first line) only runs on in-window files. The limit can't be
  // applied yet — we don't know which files match `cwd` until we read the meta,
  // so we'd otherwise drop matching-but-not-yet-seen sessions.
  const stats: { file: string; mtimeMs: number }[] = [];
  for (const file of walkRollouts(root)) {
    let st;
    try { st = statSync(file); } catch { continue; }
    stats.push({ file, mtimeMs: st.mtimeMs });
  }
  const windowed = selectRecentStats(stats, { sinceMs: opts.sinceMs, now: opts.now });

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
    if (!meta || !meta.id || meta.cwd !== cwd) continue;
    out.push({
      sessionId: meta.id,
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
  const root = join(codexHome, "sessions");
  if (!existsSync(root)) return 0;
  let n = 0;
  for (const file of walkRollouts(root)) {
    let meta: { id?: string; cwd?: string } | undefined;
    try { meta = readSessionMeta(file); } catch { continue; }
    if (meta && meta.id && meta.cwd === cwd) n++;
  }
  return n;
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
  const first = readFirstLine(file).trim();
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
 * The very first user message is usually an `<environment_context>` injection
 * (analogous to claude's `<local-command-caveat>`); skip those wrappers.
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
    const content = p.content;
    const text = Array.isArray(content)
      ? content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("")
      : typeof content === "string"
        ? content
        : "";
    const t = text.trim();
    if (!t) continue;
    if (t.startsWith("<environment_context>")) continue;
    return t.slice(0, 200);
  }
  return "";
}

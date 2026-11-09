/**
 * Persisted Session listing.
 *
 * Owns the two-pass directory scan behind SessionManager.list() and the Host
 * listing seam: stat-only ordering, bounded no-follow state.json reads, the
 * workspace/visibility filters applied before the limit, and the tail-reading
 * last-user-message preview. Ephemeral and malformed Sessions are skipped.
 */

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { SessionState } from "../types.js";
import { isEphemeralSessionState, normalizedSessionKind } from "./session-state-shape.js";

export type SessionListEntry = SessionState & {
  preview?: string;
  /** Last activity time — transcript mtime, falling back to startedAt. */
  lastActiveAt: number;
};

const MAX_LIST_STATE_BYTES = 1024 * 1024;
const MAX_PREVIEW_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_CHARS = 64 * 1024;

/** In-repo Host listing seam; SessionManager's public list contract remains unchanged. */
export function listSessionEntries(
  sessionsDir: string,
  limit = 20,
  opts?: {
    excludeKinds?: readonly string[];
    /** Metadata-only callers must not open transcript bodies for previews. */
    includePreview?: boolean;
    /** Apply workspace/visibility filters before the result limit and previews. */
    cwd?: string;
    archived?: boolean;
    rootsOnly?: boolean;
    before?: { lastActiveAt: number; sessionId: string };
    filter?: (entry: Readonly<SessionListEntry>) => boolean;
  },
  storage?: {
    candidates(): { dir: string; lastActiveAt: number; transcriptExists: boolean }[];
    readState(sessionId: string, maximumBytes: number): string;
  },
): SessionListEntry[] {
  if (!existsSync(sessionsDir)) return [];
  // Core is domain-agnostic: only the composition root knows which
  // extension-owned kinds belong outside its generic list. AgentServer passes
  // the resolved hidden-kind union explicitly; direct SDK callers see every
  // kind unless they choose exclusions themselves.
  const excludeKinds = opts?.excludeKinds ?? [];

  type Candidate = {
    dir: string;
    lastActiveAt: number;
    transcriptFile: string;
    stateFile: string;
    transcriptExists: boolean;
  };
  const candidates: Candidate[] = storage
    ? storage.candidates().map((candidate) => ({
        ...candidate,
        stateFile: join(sessionsDir, candidate.dir, "state.json"),
        transcriptFile: join(sessionsDir, candidate.dir, "transcript.jsonl"),
      }))
    : [];
  if (!storage) {
    const dirs = readdirSync(sessionsDir, { withFileTypes: true })
      .filter(
        (d) => d.isDirectory() && !d.name.startsWith(".pending-") && !d.name.startsWith("qchat-"),
      )
      .map((d) => d.name);

    // Two-pass scan. Pass 1: cheap stat to find each session's
    // lastActiveAt and sort. Pass 2 opens state.json in that order until it
    // finds `limit` non-ephemeral winners, then tails only those transcripts
    // for previews. With ~1 k sessions on disk the difference is ~1 s
    // (preview-every) vs ~50 ms (preview-top-20).
    for (const dir of dirs) {
      const stateFile = join(sessionsDir, dir, "state.json");
      if (!existsSync(stateFile)) continue;
      const transcriptFile = join(sessionsDir, dir, "transcript.jsonl");
      let lastActiveAt: number;
      let transcriptExists: boolean;
      try {
        const stateInfo = lstatSync(stateFile);
        if (
          !stateInfo.isFile() ||
          stateInfo.isSymbolicLink() ||
          stateInfo.size > MAX_LIST_STATE_BYTES
        )
          continue;
        transcriptExists = existsSync(transcriptFile);
        if (transcriptExists) {
          const transcriptInfo = lstatSync(transcriptFile);
          if (!transcriptInfo.isFile() || transcriptInfo.isSymbolicLink()) continue;
          lastActiveAt = transcriptInfo.mtimeMs;
        } else {
          // Fall back to state.json mtime (cheaper than parsing it for
          // state.startedAt and good enough for ordering).
          lastActiveAt = stateInfo.mtimeMs;
        }
      } catch {
        continue;
      }
      candidates.push({ dir, lastActiveAt, transcriptFile, stateFile, transcriptExists });
    }
  }
  candidates.sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.dir.localeCompare(b.dir));
  const sessions: SessionListEntry[] = [];
  for (const c of candidates) {
    if (sessions.length >= limit) break;
    try {
      // The cursor uses candidate metadata only. Older pages must not reopen
      // every preceding state file before reaching their first eligible row.
      if (
        opts?.before &&
        (c.lastActiveAt > opts.before.lastActiveAt ||
          (c.lastActiveAt === opts.before.lastActiveAt &&
            c.dir.localeCompare(opts.before.sessionId) <= 0))
      )
        continue;
      const state = storage
        ? parseSessionListState(storage.readState(c.dir, MAX_LIST_STATE_BYTES), c.dir)
        : readSessionListState(c.stateFile, c.dir);
      if (isEphemeralSessionState(state)) continue;
      state.kind = normalizedSessionKind(state.kind);
      if (excludeKinds.includes(state.kind)) continue;
      if (opts?.cwd !== undefined && resolve(state.cwd) !== resolve(opts.cwd)) continue;
      if (opts?.archived !== undefined && Boolean(state.archivedAt) !== opts.archived) continue;
      if (opts?.rootsOnly && state.parentSessionId) continue;
      const preview =
        opts?.includePreview !== false && c.transcriptExists
          ? readLastUserMessage(c.transcriptFile)
          : undefined;
      const entry = { ...state, preview, lastActiveAt: c.lastActiveAt };
      if (opts?.filter && !opts.filter(entry)) continue;
      sessions.push(entry);
    } catch {
      // Skip corrupted sessions
    }
  }

  return sessions;
}

/** Never follow a leaf symlink or block on a FIFO while listing optional metadata. */
function openRegularSessionListFile(file: string): { fd: number; size: number } {
  let directory: number | undefined;
  let fd: number | undefined;
  try {
    const parent = dirname(file);
    const before = lstatSync(parent);
    if (!before.isDirectory() || before.isSymbolicLink())
      throw new Error("invalid session directory");
    directory = openSync(
      parent,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0),
    );
    const openedParent = fstatSync(directory);
    if (before.dev !== openedParent.dev || before.ino !== openedParent.ino)
      throw new Error("session directory changed");
    fd = openSync(
      process.platform === "linux" ? `/proc/self/fd/${directory}/${basename(file)}` : file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const opened = fstatSync(fd);
    const current = lstatSync(file);
    const currentParent = lstatSync(parent);
    if (
      !opened.isFile() ||
      current.isSymbolicLink() ||
      currentParent.isSymbolicLink() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      currentParent.dev !== before.dev ||
      currentParent.ino !== before.ino
    )
      throw new Error("session file changed");
    return { fd, size: opened.size };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    throw error;
  } finally {
    if (directory !== undefined) closeSync(directory);
  }
}

function readSessionListState(file: string, sessionId: string): SessionState {
  const { fd, size } = openRegularSessionListFile(file);
  try {
    if (size > MAX_LIST_STATE_BYTES) throw new Error("session list state is too large");
    const buffer = Buffer.alloc(size);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
      if (!count) break;
      bytes += count;
    }
    return parseSessionListState(buffer.subarray(0, bytes).toString("utf8"), sessionId);
  } finally {
    closeSync(fd);
  }
}

function parseSessionListState(raw: string, sessionId: string): SessionState {
  if (Buffer.byteLength(raw) > MAX_LIST_STATE_BYTES)
    throw new Error("session list state is too large");
  const state = JSON.parse(raw) as SessionState;
  if (!state || state.sessionId !== sessionId || typeof state.cwd !== "string")
    throw new Error("invalid session metadata");
  return state;
}

const TAIL_CHUNK_SIZE = 64 * 1024;

/**
 * Scan a transcript.jsonl for the LAST user message and return a short
 * preview, reading the file from the END in 64 KiB chunks.
 *
 * Why: SessionManager.list() calls this for every session in
 * ~/.code-shell/sessions (hundreds to thousands at steady state). The
 * earlier readFileSync-the-whole-file implementation made `/resume`
 * scan ~64 MiB across nearly 1 k transcripts every time the list
 * opened — visible as several seconds of UI freeze. The vast majority
 * of transcripts have their last user message in the final few KiB, so
 * tailing one chunk is usually enough and we never read more than we
 * have to.
 *
 * Algorithm: open the file once, seek to the tail, read backwards one
 * chunk at a time, splitting on newlines. Walk the lines we have so
 * far from newest to oldest; the moment we find a `type:"message",
 * role:"user"` event with non-empty text we close the fd and return.
 * Keep a small "leftover" prefix between chunks so a JSON line straddling
 * a chunk boundary still parses.
 *
 * Returns undefined if the session has no user messages, or on any IO
 * error (caller treats the preview as optional).
 */

function readLastUserMessage(transcriptFile: string): string | undefined {
  if (!existsSync(transcriptFile)) return undefined;

  let fd: number;
  let fileSize: number;
  try {
    const opened = openRegularSessionListFile(transcriptFile);
    fd = opened.fd;
    fileSize = opened.size;
  } catch {
    return undefined;
  }
  if (fileSize === 0) {
    closeSync(fd);
    return undefined;
  }

  try {
    let position = fileSize;
    // `leftover` holds bytes from the previous (later) chunk that we
    // couldn't yet split on a newline — they're the partial start of a
    // line whose end lives in the older chunk we just read.
    let leftover = "";
    const buf = Buffer.alloc(TAIL_CHUNK_SIZE);

    const minimumPosition = Math.max(0, fileSize - MAX_PREVIEW_SCAN_BYTES);
    while (position > minimumPosition) {
      const readLen = Math.min(TAIL_CHUNK_SIZE, position - minimumPosition);
      position -= readLen;
      const got = readSync(fd, buf, 0, readLen, position);
      if (got <= 0) break;
      const text = buf.toString("utf8", 0, got) + leftover;
      const lines = text.split("\n");
      // If we haven't reached the beginning of the file, the first
      // element of `lines` may be a partial line; defer it to the next
      // (older) chunk. Once position==0 we know the first element is a
      // real complete line and we should process it too.
      const start = position === 0 ? 0 : 1;
      if (position > 0) leftover = lines[0] ?? "";
      for (let i = lines.length - 1; i >= start; i--) {
        const preview = parseUserPreview(lines[i]);
        if (preview !== undefined) return preview;
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

/**
 * Parse one transcript line; return the preview string if it's a
 * non-empty user message, otherwise undefined. Pulled out so the
 * tail loop above stays focused on IO mechanics.
 */
function parseUserPreview(line: string | undefined): string | undefined {
  if (!line) return undefined;
  let event: {
    type?: string;
    data?: { role?: string; content?: unknown; injected?: boolean };
  };
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (event.type !== "message") return undefined;
  if (event.data?.role !== "user") return undefined;
  if (event.data.injected === true) return undefined;
  const content = event.data.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? (content.find((b: { type?: string; text?: string }) => b.type === "text")?.text ?? "")
        : "";
  if (!text.trim()) return undefined;
  // Hosts strip attachment metadata before collapsing whitespace for display.
  return text.trim().slice(0, MAX_PREVIEW_CHARS);
}

/**
 * Session lifecycle manager.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { nanoid } from "nanoid";
import type { SessionState } from "../types.js";
import { Transcript } from "./transcript.js";
import { SessionError } from "../exceptions.js";
import { normalizeCumulativeUsageCounters } from "../engine/session-usage.js";

export interface SessionBundle {
  state: SessionState;
  transcript: Transcript;
}

/**
 * Validate a session ID before it is joined into a filesystem path.
 *
 * Internally generated IDs use `nanoid(16)` and are trusted by construction.
 * But every public entry point (`create`'s explicitSessionId, `resume`,
 * `exists`, `saveState`'s state.sessionId, `fork`'s sourceSessionId) accepts
 * an ID from an outside caller — protocol clients, ChatSessionManager-driven
 * cold starts, persisted state files — and join()'s it into `sessionsDir`.
 * Without this check a value like "../etc/passwd" or "/tmp/x" would let the
 * caller escape the sessions directory.
 *
 * Exported for direct unit testing.
 */
export function assertSafeSessionId(sessionId: unknown): asserts sessionId is string {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new SessionError(`invalid session id: must be a non-empty string`);
  }
  // basename check: reject any path-shaped value. Covers absolute paths,
  // POSIX and Windows separators, parent-dir tokens, and the lone "..".
  if (sessionId.includes("/") || sessionId.includes("\\")) {
    throw new SessionError(`invalid session id: contains path separator: ${sessionId}`);
  }
  if (sessionId === "." || sessionId === ".." || sessionId.includes("..")) {
    throw new SessionError(`invalid session id: contains parent-dir token: ${sessionId}`);
  }
  // Conservative character allow-list: letters, digits, and `-_.` only.
  // This matches what nanoid emits plus the dotted variants in-house code
  // already uses (e.g. "tui-main", "agent.foo"). Anything else (NUL,
  // newline, control chars, shell metacharacters, glob chars) is rejected.
  if (!/^[A-Za-z0-9_.-]+$/.test(sessionId)) {
    throw new SessionError(`invalid session id: unexpected characters: ${sessionId}`);
  }
  // Cap the length to keep filesystem APIs happy and avoid disk-name DoS.
  if (sessionId.length > 128) {
    throw new SessionError(`invalid session id: too long (max 128 chars)`);
  }
}

/**
 * Resolve the `.code-shell` home dir. `CODE_SHELL_HOME` overrides the default
 * `~/.code-shell` — mirrors Codex's `CODEX_HOME`. Tests set it to a temp dir
 * (see bunfig.toml preload) so a `new Engine()` / `new SessionManager()` with
 * no explicit storageDir doesn't pollute the user's real ~/.code-shell/sessions
 * with throwaway test sessions (the rm-usage/test-model sidebar junk).
 */
export function codeShellHome(): string {
  return process.env.CODE_SHELL_HOME || join(homedir(), ".code-shell");
}

export class SessionManager {
  private readonly sessionsDir: string;

  constructor(storageDir?: string) {
    this.sessionsDir = storageDir ?? join(codeShellHome(), "sessions");
    mkdirSync(this.sessionsDir, { recursive: true });
  }

  /**
   * Create a new on-disk session. If `explicitSessionId` is passed, use
   * it verbatim (ChatSessionManager-driven hosts choose a logical sid like
   * "tui-main" and expect us to honor it). Otherwise generate one with
   * nanoid. Either way the on-disk directory is materialized and the
   * state.json + transcript.jsonl files are written before return.
   */
  create(
    cwd: string,
    model: string,
    provider: string,
    explicitSessionId?: string,
    parentSessionId?: string | null,
    origin?: import("../types.js").SessionOrigin,
  ): SessionBundle {
    // External callers may pass any string; nanoid output is trusted. Either
    // way the ID gets joined into a filesystem path, so the public entry
    // point validates before that join.
    if (explicitSessionId !== undefined) assertSafeSessionId(explicitSessionId);
    const sessionId = explicitSessionId ?? nanoid(16);
    const sessionDir = join(this.sessionsDir, sessionId);
    try {
      mkdirSync(sessionDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new SessionError(`Session already exists: ${sessionId}`);
      }
      throw err;
    }

    const state: SessionState = {
      sessionId,
      cwd,
      startedAt: Date.now(),
      model,
      provider,
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      cumulativePromptTokens: 0,
      cumulativeCacheReadTokens: 0,
      cumulativeCacheCreationTokens: 0,
      turnCount: 0,
      invokedSkills: [],
      status: "active",
      // Always write the key: a sub-agent gets its parent sid; a top-level
      // session gets explicit null. This lets the desktop disk-rebuild tell a
      // new top-level session (key present, null) apart from a legacy session
      // (key absent) and from a sub-agent (key present, non-empty string).
      parentSessionId: parentSessionId ?? null,
      ...(origin ? { origin } : {}),
    };

    // Atomic write (tmp+rename) like saveState, so a crash during this one-time
    // create can't leave a torn state.json that resume() then fails to parse.
    const stateTarget = join(sessionDir, "state.json");
    const stateTmp = `${stateTarget}.${process.pid}.${Date.now()}.create.tmp`;
    writeFileSync(stateTmp, JSON.stringify(state, null, 2), "utf-8");
    renameSync(stateTmp, stateTarget);

    const transcript = new Transcript(join(sessionDir, "transcript.jsonl"));
    transcript.append("session_meta", {
      sessionId,
      cwd,
      model,
      provider,
      startedAt: state.startedAt,
    });

    return { state, transcript };
  }

  /**
   * Whether a session directory exists on disk. Used by ChatSession-driven
   * cold starts to decide between resume vs create-with-explicit-sid
   * without catching SessionError.
   */
  exists(sessionId: string): boolean {
    // exists() is a probe — callers use it to decide between resume and
    // create-with-explicit-sid. Treat an invalid id as "not present"
    // rather than letting the traversal-shaped string reach existsSync.
    try {
      assertSafeSessionId(sessionId);
    } catch {
      return false;
    }
    return existsSync(join(this.sessionsDir, sessionId));
  }

  /**
   * Cheap "what cwd is this session bound to?" probe — reads only state.json,
   * NOT the transcript (unlike resume()). engine.run uses this to recover a
   * resumed session's project directory when the caller omits options.cwd
   * (e.g. a desktop host whose sidebar repo selection has drifted to null),
   * so a project-bound session keeps loading its own agents/settings/memory
   * instead of falling back to process.cwd(). Returns undefined for an
   * unknown, malformed, or traversal-shaped id rather than throwing — the
   * caller treats "no recoverable cwd" the same as "not given".
   */
  readCwd(sessionId: string): string | undefined {
    try {
      assertSafeSessionId(sessionId);
    } catch {
      return undefined;
    }
    const stateFile = join(this.sessionsDir, sessionId, "state.json");
    if (!existsSync(stateFile)) return undefined;
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf-8")) as SessionState;
      return typeof state.cwd === "string" && state.cwd.length > 0 ? state.cwd : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Cheap "does this session have a persisted goal?" probe — reads only
   * state.json, NOT the transcript (like readCwd). A persistent goal lives ONLY
   * in state.activeGoal; it is never appended to the transcript as an event, so
   * a session rebuilt from disk (e.g. localStorage wiped) can't recover the
   * goal from its messages. The desktop host calls this on session load to
   * re-surface the active-goal block + its Cancel button, which would otherwise
   * be invisible (and thus uncancellable) after a reload of an aborted goal
   * run. Returns undefined for an unknown / malformed / traversal-shaped id, or
   * a session with no active goal — never throws.
   */
  readActiveGoal(sessionId: string): import("../engine/goal.js").GoalConfig | undefined {
    try {
      assertSafeSessionId(sessionId);
    } catch {
      return undefined;
    }
    const stateFile = join(this.sessionsDir, sessionId, "state.json");
    if (!existsSync(stateFile)) return undefined;
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf-8")) as SessionState;
      return state.activeGoal;
    } catch {
      return undefined;
    }
  }

  /**
   * Disk-only "wipe this session's persistent goal" — the counterpart to
   * readActiveGoal. Reads state.json, removes state.activeGoal, and rewrites it
   * atomically (via saveState). Returns true only if a goal was actually
   * present (idempotent — clearing a session with no goal is a no-op returning
   * false). Never throws on an unknown / malformed / traversal-shaped id
   * (returns false), matching readActiveGoal's tolerance.
   *
   * Why it lives here and not only on Engine: a persistent goal can strand a
   * session whose worker is NOT live (aborted/reloaded) — Engine.clearGoal
   * needs a resumed in-RAM session and a matching in-flight hook, neither of
   * which exists once the worker has exited. Hosts (the desktop bridge) call
   * THIS to clear such a goal off disk without spinning up a full Engine.
   * Engine.clearGoal also delegates its disk write here so the wipe logic lives
   * in exactly one place.
   */
  clearActiveGoal(sessionId: string): boolean {
    try {
      assertSafeSessionId(sessionId);
    } catch {
      return false;
    }
    const stateFile = join(this.sessionsDir, sessionId, "state.json");
    if (!existsSync(stateFile)) return false;
    let state: SessionState;
    try {
      state = JSON.parse(readFileSync(stateFile, "utf-8")) as SessionState;
    } catch {
      return false;
    }
    if (state.activeGoal === undefined) return false;
    state.activeGoal = undefined;
    this.saveState(state);
    return true;
  }

  resume(sessionId: string): SessionBundle {
    assertSafeSessionId(sessionId);
    const sessionDir = join(this.sessionsDir, sessionId);
    if (!existsSync(sessionDir)) {
      throw new SessionError(`Session not found: ${sessionId}`);
    }

    const stateFile = join(sessionDir, "state.json");
    if (!existsSync(stateFile)) {
      throw new SessionError(`Session state file not found: ${sessionId}`);
    }

    let state: SessionState;
    try {
      state = JSON.parse(readFileSync(stateFile, "utf-8")) as SessionState;
    } catch (err) {
      // A corrupt state.json (external tampering, disk corruption, or a crash
      // during the one-time create() write) must surface as a clean SessionError
      // — not a raw SyntaxError that escapes callers expecting SessionError.
      throw new SessionError(
        `Session state is corrupt for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const transcriptFile = join(sessionDir, "transcript.jsonl");
    const transcript = Transcript.loadFromFile(transcriptFile);

    state.status = "active";
    Object.assign(state, normalizeCumulativeUsageCounters(state, state.tokenUsage));

    return { state, transcript };
  }

  saveState(state: SessionState): void {
    // state.sessionId could come from a deserialized state.json that was
    // tampered with on disk. Validate before joining.
    assertSafeSessionId(state.sessionId);
    const sessionDir = join(this.sessionsDir, state.sessionId);
    mkdirSync(sessionDir, { recursive: true });
    // Atomic write: stage to .tmp, then rename. Protects against two processes
    // clobbering each other's state.json mid-write.
    const target = join(sessionDir, "state.json");
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    renameSync(tmp, target);
  }

  /**
   * Fork a session from a specific point.
   * Creates a new session that shares events up to the given turn,
   * then diverges independently.
   */
  fork(sourceSessionId: string, forkAtTurn?: number): SessionBundle {
    const source = this.resume(sourceSessionId);
    const events = source.transcript.getEvents();

    // Determine fork point
    const forkTurn = forkAtTurn ?? source.state.turnCount;

    // Create new session
    const newBundle = this.create(source.state.cwd, source.state.model, source.state.provider);
    newBundle.state.parentSessionId = sourceSessionId;

    // Copy events up to the fork point
    for (const event of events) {
      if (
        event.type === "turn_boundary" &&
        ((event.data.turnNumber as number | undefined) ?? -1) > forkTurn
      ) {
        break;
      }
      newBundle.transcript.append(event.type, event.data);
    }

    this.saveState(newBundle.state);
    return newBundle;
  }

  list(limit = 20): SessionListEntry[] {
    if (!existsSync(this.sessionsDir)) return [];

    const dirs = readdirSync(this.sessionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    // Two-pass scan. Pass 1: cheap stat to find each session's
    // lastActiveAt, sort, take top `limit`. Pass 2: only for those
    // winners do we open state.json + tail the transcript for a
    // preview. With ~1 k sessions on disk the difference is ~1 s
    // (preview-every) vs ~50 ms (preview-top-20).
    type Candidate = {
      dir: string;
      lastActiveAt: number;
      transcriptFile: string;
      stateFile: string;
      transcriptExists: boolean;
    };
    const candidates: Candidate[] = [];
    for (const dir of dirs) {
      const stateFile = join(this.sessionsDir, dir, "state.json");
      if (!existsSync(stateFile)) continue;
      const transcriptFile = join(this.sessionsDir, dir, "transcript.jsonl");
      let lastActiveAt: number;
      let transcriptExists = false;
      try {
        transcriptExists = existsSync(transcriptFile);
        if (transcriptExists) {
          lastActiveAt = statSync(transcriptFile).mtimeMs;
        } else {
          // Fall back to state.json mtime (cheaper than parsing it for
          // state.startedAt and good enough for ordering).
          lastActiveAt = statSync(stateFile).mtimeMs;
        }
      } catch {
        continue;
      }
      candidates.push({ dir, lastActiveAt, transcriptFile, stateFile, transcriptExists });
    }

    candidates.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    const top = candidates.slice(0, limit);

    const sessions: SessionListEntry[] = [];
    for (const c of top) {
      try {
        const state = JSON.parse(readFileSync(c.stateFile, "utf-8")) as SessionState;
        const preview = c.transcriptExists ? readLastUserMessage(c.transcriptFile) : undefined;
        sessions.push({ ...state, preview, lastActiveAt: c.lastActiveAt });
      } catch {
        // Skip corrupted sessions
      }
    }

    return sessions;
  }
}

export type SessionListEntry = SessionState & {
  preview?: string;
  /** Last activity time — transcript mtime, falling back to startedAt. */
  lastActiveAt: number;
};

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
const TAIL_CHUNK_SIZE = 64 * 1024;

function readLastUserMessage(transcriptFile: string): string | undefined {
  if (!existsSync(transcriptFile)) return undefined;

  let fd: number;
  let fileSize: number;
  try {
    fd = openSync(transcriptFile, "r");
    fileSize = statSync(transcriptFile).size;
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

    while (position > 0) {
      const readLen = Math.min(TAIL_CHUNK_SIZE, position);
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
  return text.replace(/\s+/g, " ").trim();
}

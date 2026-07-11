/**
 * Session lifecycle manager.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { nanoid } from "nanoid";
import type {
  SessionForkLineage,
  SessionState,
  SessionWorkspace,
  TranscriptEvent,
  TranscriptEventType,
} from "../types.js";
import { Transcript } from "./transcript.js";
import { SessionError } from "../exceptions.js";
import { normalizeCumulativeUsageCounters } from "../engine/session-usage.js";
import { isSameGoalInstance, type GoalTerminal } from "../engine/goal.js";
import { branchExists, isGitWorktreeRoot } from "../git/worktree.js";

// Shared close epochs for SessionManager instances in this process. Concurrent
// Engines bind the same epoch; only close advances it. This intentionally does
// not claim cross-process/Worker protection.
const currentSessionCloseEpochs = new Map<string, number>();

export interface SessionBundle {
  state: SessionState;
  transcript: Transcript;
}

export interface ForkSessionOptions {
  targetSessionId?: string;
  /** Inclusive source event cursor; omitted means the frozen transcript tail. */
  throughEventId?: string;
  /** `completed` is the interrupted snapshot used by ephemeral side chats. */
  snapshotMode?: "tail" | "completed";
}

export interface ForkSessionResult {
  bundle: SessionBundle;
  lineage: SessionForkLineage;
  copiedEventCount: number;
}

interface FrozenForkSnapshot {
  sourceState: SessionState;
  copiedEvents: TranscriptEvent[];
}

const FORK_COPY_EVENT_TYPES: ReadonlySet<TranscriptEventType> = new Set([
  "message",
  "tool_use",
  "tool_result",
  "summary",
  "content_replace",
  "subagent",
  "external_file_changes",
  "goal_progress",
  "turn_boundary",
  "turn_stopped",
  "error",
]);
const FORK_SKIP_EVENT_TYPES: ReadonlySet<TranscriptEventType> = new Set([
  "session_meta",
  "file_history",
  "plan_operation",
]);
const FORK_STAGING_NAME = /^\.pending-fork-[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}$/;
const FORK_STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FORK_STAGING_CLEANUP_LIMIT = 32;

export type SessionWorkspaceResumeResolution =
  | {
      ok: true;
      cwd: string;
      workspace: SessionWorkspace;
      message?: string;
      reason?: "main" | "worktree" | "legacy" | "worktree_missing_branch_gone";
    }
  | {
      ok: false;
      cwd: string;
      workspace: SessionWorkspace;
      message: string;
      reason: "worktree_missing_branch_exists";
    };

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

function isSessionWorkspace(value: unknown): value is SessionWorkspace {
  if (!value || typeof value !== "object") return false;
  const ws = value as Partial<SessionWorkspace>;
  if (typeof ws.root !== "string" || ws.root.length === 0) return false;
  if (ws.kind !== "main" && ws.kind !== "worktree") return false;
  if (ws.kind === "main") return ws.worktree === undefined;
  const wt = ws.worktree as SessionWorkspace["worktree"] | undefined;
  return (
    !!wt &&
    typeof wt.path === "string" &&
    wt.path.length > 0 &&
    typeof wt.branch === "string" &&
    wt.branch.length > 0 &&
    typeof wt.baseRef === "string" &&
    wt.baseRef.length > 0 &&
    wt.createdBy === "codeshell"
  );
}

async function validateResumeWorktreeRoot(root: string): Promise<string | null> {
  if (!existsSync(root)) return "no longer exists";
  let stat;
  try {
    stat = lstatSync(root);
  } catch {
    return "no longer exists";
  }
  if (stat.isSymbolicLink()) return "is not a valid git worktree (symbolic link)";
  if (!stat.isDirectory()) return "is not a valid git worktree (not a directory)";
  if (!(await isGitWorktreeRoot(root))) return "is not a valid git worktree";
  return null;
}

export class SessionManager {
  private readonly sessionsDir: string;
  private readonly registeredCloseEpochs = new Map<string, number>();

  constructor(storageDir?: string) {
    this.sessionsDir = storageDir ?? join(codeShellHome(), "sessions");
    mkdirSync(this.sessionsDir, { recursive: true });
    this.cleanupStaleForkStaging();
  }

  private cleanupStaleForkStaging(): void {
    let removed = 0;
    let entries;
    try {
      entries = readdirSync(this.sessionsDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (removed >= FORK_STAGING_CLEANUP_LIMIT) return;
      if (!entry.isDirectory() || !FORK_STAGING_NAME.test(entry.name)) continue;
      const path = join(this.sessionsDir, entry.name);
      try {
        if (Date.now() - statSync(path).mtimeMs <= FORK_STAGING_MAX_AGE_MS) continue;
        rmSync(path, { recursive: true, force: true });
        removed++;
      } catch {
        // Startup cleanup is best effort; a live/unreadable staging directory
        // must never prevent the SessionManager from serving normal sessions.
      }
    }
  }

  /** Bind one Engine/session pair to the current close epoch without advancing it. */
  registerSessionGeneration(sessionId: string): number {
    assertSafeSessionId(sessionId);
    const key = this.generationKey(sessionId);
    const generation = currentSessionCloseEpochs.get(key) ?? 0;
    this.registeredCloseEpochs.set(sessionId, generation);
    return generation;
  }

  /** Advance the close epoch once before close waits for the old run to settle. */
  incrementSessionGeneration(sessionId: string): number {
    assertSafeSessionId(sessionId);
    const key = this.generationKey(sessionId);
    const next = (currentSessionCloseEpochs.get(key) ?? 0) + 1;
    currentSessionCloseEpochs.set(key, next);
    return next;
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
      workspace: { root: cwd, kind: "main" },
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
   * Disk-only workspace pointer reader. Legacy sessions written before
   * `workspace` existed are treated as main-workspace sessions rooted at
   * `state.cwd`; the read is intentionally non-mutating.
   */
  getSessionWorkspace(sessionId: string): SessionWorkspace | undefined {
    try {
      assertSafeSessionId(sessionId);
    } catch {
      return undefined;
    }
    const stateFile = join(this.sessionsDir, sessionId, "state.json");
    if (!existsSync(stateFile)) return undefined;
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf-8")) as SessionState;
      if (isSessionWorkspace(state.workspace)) return state.workspace;
      return typeof state.cwd === "string" && state.cwd.length > 0
        ? { root: state.cwd, kind: "main" }
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Persist the current session workspace pointer without changing legacy
   * `cwd`. P1 will teach ToolContext to resolve cwd from this field; for P0 it
   * is a safety pointer and resume breadcrumb.
   */
  setSessionWorkspace(sessionId: string, workspace: SessionWorkspace): void {
    assertSafeSessionId(sessionId);
    if (!isSessionWorkspace(workspace)) {
      throw new SessionError(`invalid workspace for session ${sessionId}`);
    }
    const stateFile = join(this.sessionsDir, sessionId, "state.json");
    if (!existsSync(stateFile)) {
      throw new SessionError(`Session state file not found: ${sessionId}`);
    }
    let state: SessionState;
    try {
      state = JSON.parse(readFileSync(stateFile, "utf-8")) as SessionState;
    } catch (err) {
      throw new SessionError(
        `Session state is corrupt for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    state.workspace = workspace;
    this.saveState(state);
  }

  recordWorkspaceHandoff(
    sessionId: string,
    from: SessionWorkspace | undefined,
    to: SessionWorkspace,
  ): void {
    assertSafeSessionId(sessionId);
    const transcriptFile = join(this.sessionsDir, sessionId, "transcript.jsonl");
    if (!existsSync(transcriptFile)) return;
    try {
      const transcript = new Transcript(transcriptFile);
      transcript.append("session_meta", {
        sessionId,
        cwd: to.root,
        workspace: to,
        handoffFrom: from?.root,
        handoffAt: Date.now(),
      });
    } catch {
      // Transcript handoff metadata is best-effort; state.workspace is the
      // authoritative switch pointer.
    }
  }

  /**
   * Resolve the cwd a resumed session must run in from its persisted workspace
   * pointer. A missing worktree directory is never silently treated as the main
   * repo: if the branch still exists callers get a blocking recreate message;
   * if the branch is gone the workspace pointer is reset to main and a warning
   * message is returned for the host to surface before continuing.
   */
  async resolveSessionWorkspaceForResume(
    sessionId: string,
  ): Promise<SessionWorkspaceResumeResolution> {
    assertSafeSessionId(sessionId);
    const stateFile = join(this.sessionsDir, sessionId, "state.json");
    if (!existsSync(stateFile)) {
      throw new SessionError(`Session state file not found: ${sessionId}`);
    }
    let state: SessionState;
    try {
      state = JSON.parse(readFileSync(stateFile, "utf-8")) as SessionState;
    } catch (err) {
      throw new SessionError(
        `Session state is corrupt for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const legacyMain =
      typeof state.cwd === "string" && state.cwd.length > 0
        ? ({ root: state.cwd, kind: "main" } as const)
        : undefined;
    const workspace = isSessionWorkspace(state.workspace) ? state.workspace : legacyMain;
    if (!workspace) {
      throw new SessionError(`Session ${sessionId} has no recoverable cwd`);
    }

    if (workspace.kind === "main") {
      return {
        ok: true,
        cwd: workspace.root,
        workspace,
        reason: isSessionWorkspace(state.workspace) ? "main" : "legacy",
      };
    }

    const invalidWorktreeReason = await validateResumeWorktreeRoot(workspace.root);
    if (!invalidWorktreeReason) {
      return { ok: true, cwd: workspace.root, workspace, reason: "worktree" };
    }

    const branch = workspace.worktree?.branch;
    const mainRoot =
      typeof state.cwd === "string" && state.cwd.length > 0 ? state.cwd : workspace.root;
    if (branch && existsSync(mainRoot) && (await branchExists(mainRoot, branch))) {
      return {
        ok: false,
        cwd: mainRoot,
        workspace,
        reason: "worktree_missing_branch_exists",
        message:
          `Session ${sessionId} is bound to worktree ${workspace.root}, but that directory ` +
          `${invalidWorktreeReason}. Branch ${branch} still exists; recreate the worktree at ` +
          `${workspace.worktree?.path ?? workspace.root} before resuming, or switch this session ` +
          `back to main explicitly.`,
      };
    }

    const fallback: SessionWorkspace = { root: mainRoot, kind: "main" };
    state.workspace = fallback;
    this.saveState(state);
    return {
      ok: true,
      cwd: mainRoot,
      workspace: fallback,
      reason: "worktree_missing_branch_gone",
      message:
        `Session ${sessionId} was bound to worktree ${workspace.root}, but that directory ` +
        `${invalidWorktreeReason}${branch ? ` and branch ${branch} is gone` : ""}; fell back to main ` +
        `${mainRoot}. Re-run the request if you want to continue there.`,
    };
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
      return isSameGoalInstance(state.activeGoal, state.goalTerminal)
        ? undefined
        : state.activeGoal;
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

  /**
   * Merge a field-level state update into the latest persisted snapshot.
   *
   * Unlike saveState(), callers do not supply a potentially stale whole-state
   * object. The read, shallow merge, and atomic write are synchronous, so no
   * other callback on this process's event loop can interleave between them.
   * This is deliberately not a session-level lock. Engine.run rejects re-entry
   * on one Engine (G6), and the generation check in saveState rejects an older
   * registered Engine in this process. Workers and separate processes remain
   * an unresolved finding requiring locking/CAS.
   */
  updateSessionState(
    sessionId: string,
    partial: Readonly<Partial<Omit<SessionState, "sessionId">>>,
  ): void {
    assertSafeSessionId(sessionId);
    const stateFile = join(this.sessionsDir, sessionId, "state.json");
    if (!existsSync(stateFile)) {
      throw new SessionError(`Session state file not found: ${sessionId}`);
    }
    let state: SessionState;
    try {
      state = JSON.parse(readFileSync(stateFile, "utf-8")) as SessionState;
    } catch (err) {
      throw new SessionError(
        `Session state is corrupt for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    Object.assign(state, partial);
    state.sessionId = sessionId;
    this.saveState(state);
  }

  saveState(state: SessionState, generation?: number): boolean {
    // state.sessionId could come from a deserialized state.json that was
    // tampered with on disk. Validate before joining.
    assertSafeSessionId(state.sessionId);
    const writerGeneration = generation ?? this.registeredCloseEpochs.get(state.sessionId);
    if (
      writerGeneration !== undefined &&
      (currentSessionCloseEpochs.get(this.generationKey(state.sessionId)) ?? 0) !== writerGeneration
    ) {
      // A closing/old Engine may finish asynchronously after its generation was
      // invalidated. Reject explicitly without throwing into an unobserved
      // engine finally path, and most importantly without touching the disk.
      return false;
    }
    const sessionDir = join(this.sessionsDir, state.sessionId);
    mkdirSync(sessionDir, { recursive: true });
    // Atomic file replacement: stage to .tmp, then rename, preventing a torn
    // state.json. Registered Engines share one epoch until close advances it,
    // so concurrent opens are not fenced from each other. Workers, separate
    // processes, and their stale-writer ordering still require locking/CAS.
    const target = join(sessionDir, "state.json");
    // Preserve the newest goal tombstone across whole-state writers. If an old
    // detached bundle still carries the tombstoned goal, drop it before write;
    // when disk already contains a newer replacement goal, retain that goal as
    // well instead of letting the stale bundle erase it.
    let persisted: SessionState | undefined;
    if (existsSync(target)) {
      try {
        persisted = JSON.parse(readFileSync(target, "utf-8")) as SessionState;
      } catch {
        // The atomic writer should make this rare. Preserve the existing
        // behavior and overwrite malformed state with the caller's snapshot.
      }
    }
    // A title is generated after the first run and may be merged while the
    // next run still owns a state object loaded before that title existed.
    // Preserve the newly persisted title when such a stale whole-state writer
    // saves later; assigning title = undefined explicitly still clears it.
    if (persisted?.title !== undefined && !("title" in state)) {
      state.title = persisted.title;
    }
    const terminal = newestGoalTerminal(state.goalTerminal, persisted?.goalTerminal);
    if (terminal) state.goalTerminal = terminal;
    if (terminal && isSameGoalInstance(state.activeGoal, terminal)) {
      const diskGoal = persisted?.activeGoal;
      state.activeGoal = diskGoal && !isSameGoalInstance(diskGoal, terminal) ? diskGoal : undefined;
    }
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    renameSync(tmp, target);
    return true;
  }

  private generationKey(sessionId: string): string {
    return `${this.sessionsDir}\0${sessionId}`;
  }

  /** Create an independent, top-level session from a frozen event cursor. */
  fork(sourceSessionId: string, options: ForkSessionOptions = {}): ForkSessionResult {
    assertSafeSessionId(sourceSessionId);
    if (options.targetSessionId !== undefined) assertSafeSessionId(options.targetSessionId);
    if (options.snapshotMode === "completed" && options.throughEventId !== undefined) {
      throw new SessionError(`Completed snapshot cannot use an explicit fork cursor`);
    }
    const snapshot = this.readForkSnapshot(
      sourceSessionId,
      options.throughEventId,
      options.snapshotMode ?? "tail",
    );
    const targetSessionId = options.targetSessionId ?? nanoid(16);
    const createdAt = Date.now();
    const lineage: SessionForkLineage = {
      sessionId: sourceSessionId,
      mode: "full",
      fromEventId: snapshot.copiedEvents[0]?.id,
      throughEventId: snapshot.copiedEvents[snapshot.copiedEvents.length - 1]?.id,
      sourceEventCount: snapshot.copiedEvents.length,
      createdAt,
    };
    const state = buildForkState(snapshot.sourceState, targetSessionId, lineage, createdAt);
    const events = buildForkTranscript(snapshot.copiedEvents, state);
    const bundle = this.publishSessionAtomically(targetSessionId, state, events);
    return { bundle, lineage, copiedEventCount: snapshot.copiedEvents.length };
  }

  private readForkSnapshot(
    sourceSessionId: string,
    throughEventId: string | undefined,
    snapshotMode: "tail" | "completed",
  ): FrozenForkSnapshot {
    const sessionDir = join(this.sessionsDir, sourceSessionId);
    const stateFile = join(sessionDir, "state.json");
    const transcriptFile = join(sessionDir, "transcript.jsonl");
    if (!existsSync(stateFile)) throw new SessionError(`Session not found: ${sourceSessionId}`);
    let sourceState: SessionState;
    try {
      sourceState = JSON.parse(readFileSync(stateFile, "utf-8")) as SessionState;
    } catch (err) {
      throw new SessionError(
        `Session state is corrupt for ${sourceSessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const parsed = Transcript.readEvents(transcriptFile);
    if (parsed.malformedLineCount > 0) {
      throw new SessionError(
        `Session transcript is malformed for ${sourceSessionId}: ${parsed.malformedLineCount} invalid line(s)`,
      );
    }
    const sourceEvents = structuredClone(parsed.events);
    let frozen = sourceEvents;
    const effectiveCursor =
      snapshotMode === "completed" ? sourceState.completedThroughEventId : throughEventId;
    if (snapshotMode === "completed" && effectiveCursor === undefined) {
      // Legacy sessions predate completedThroughEventId. Their tail is a safe
      // completed snapshot only when the persisted lifecycle status says the
      // last run completed naturally. Active/error/abort tails may be partial.
      frozen = sourceState.status === "completed" ? sourceEvents : [];
    } else if (effectiveCursor !== undefined) {
      const matches = sourceEvents
        .map((event, index) => (event.id === effectiveCursor ? index : -1))
        .filter((index) => index >= 0);
      if (matches.length !== 1) {
        throw new SessionError(
          snapshotMode === "completed"
            ? `Completed fork cursor must identify exactly one source event`
            : `Fork cursor must identify exactly one source event`,
        );
      }
      const cursor = sourceEvents[matches[0]];
      if (cursor.type === "session_meta") {
        throw new SessionError(`Fork cursor cannot point at session metadata`);
      }
      frozen = sourceEvents.slice(0, matches[0] + 1);
    }

    const copiedEvents: TranscriptEvent[] = [];
    for (const event of frozen) {
      if (FORK_SKIP_EVENT_TYPES.has(event.type)) continue;
      if (!FORK_COPY_EVENT_TYPES.has(event.type)) {
        throw new SessionError(`Unsupported transcript event in fork: ${String(event.type)}`);
      }
      copiedEvents.push(structuredClone(event));
    }
    validateForkToolPairs(copiedEvents);
    return { sourceState: structuredClone(sourceState), copiedEvents };
  }

  private publishSessionAtomically(
    targetSessionId: string,
    state: SessionState,
    events: readonly TranscriptEvent[],
  ): SessionBundle {
    const targetDir = join(this.sessionsDir, targetSessionId);
    if (existsSync(targetDir)) throw new SessionError(`Session already exists: ${targetSessionId}`);
    const stagingDir = join(this.sessionsDir, `.pending-fork-${targetSessionId}-${nanoid(8)}`);
    let published = false;
    try {
      mkdirSync(stagingDir);
      writeFileSync(join(stagingDir, "state.json"), JSON.stringify(state, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
      const jsonl = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
      writeFileSync(join(stagingDir, "transcript.jsonl"), jsonl, {
        encoding: "utf-8",
        mode: 0o600,
      });
      if (existsSync(targetDir)) {
        throw new SessionError(`Session already exists: ${targetSessionId}`);
      }
      renameSync(stagingDir, targetDir);
      published = true;
      return this.resume(targetSessionId);
    } finally {
      if (!published) rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  list(limit = 20): SessionListEntry[] {
    if (!existsSync(this.sessionsDir)) return [];

    const dirs = readdirSync(this.sessionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".pending-"))
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
      let transcriptExists: boolean;
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

export function buildForkState(
  source: SessionState,
  targetSessionId: string,
  lineage: SessionForkLineage,
  startedAt = Date.now(),
): SessionState {
  const workspace = isSessionWorkspace(source.workspace)
    ? structuredClone(source.workspace)
    : { root: source.cwd, kind: "main" as const };
  return {
    sessionId: targetSessionId,
    cwd: source.cwd,
    workspace,
    startedAt,
    model: source.model,
    provider: source.provider,
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    cumulativePromptTokens: 0,
    cumulativeCacheReadTokens: 0,
    cumulativeCacheCreationTokens: 0,
    turnCount: 0,
    turnSeq: 0,
    invokedSkills: [],
    parentSessionId: null,
    forkedFrom: structuredClone(lineage),
    ...(source.origin ? { origin: source.origin } : {}),
    status: "active",
  };
}

export function buildForkTranscript(
  sourceEvents: readonly TranscriptEvent[],
  state: SessionState,
): TranscriptEvent[] {
  const meta: TranscriptEvent = {
    id: nanoid(12),
    type: "session_meta",
    timestamp: state.startedAt,
    turnNumber: 0,
    data: {
      sessionId: state.sessionId,
      cwd: state.cwd,
      workspace: structuredClone(state.workspace),
      model: state.model,
      provider: state.provider,
      startedAt: state.startedAt,
      forkedFrom: structuredClone(state.forkedFrom),
    },
  };
  return [
    meta,
    ...sourceEvents.map((source) => ({
      ...structuredClone(source),
      id: nanoid(12),
    })),
  ];
}

function validateForkToolPairs(events: readonly TranscriptEvent[]): void {
  const projectedUses: string[] = [];
  const projectedResults: string[] = [];
  const seenProjectedUses = new Set<string>();
  const seenProjectedResults = new Set<string>();
  const projectedPending: string[] = [];

  for (const message of Transcript.eventsToMessages(events)) {
    const blocks = Array.isArray(message.content) ? message.content : [];
    const uses = blocks.filter((block) => block.type === "tool_use");
    const results = blocks.filter((block) => block.type === "tool_result");

    if (projectedPending.length > 0) {
      if (message.role !== "user" || results.length !== blocks.length || results.length === 0) {
        throw new SessionError(
          `Fork provider history inserts a message before pending tool results`,
        );
      }
    } else if (results.length > 0) {
      throw new SessionError(`Fork provider history contains an orphaned tool result`);
    }

    if (uses.length > 0) {
      if (message.role !== "assistant" || results.length > 0) {
        throw new SessionError(`Fork provider history contains tool use blocks in an invalid role`);
      }
      for (const block of uses) {
        const id = block.id;
        if (typeof id !== "string" || !id) {
          throw new SessionError(`Fork provider history contains a tool use without id`);
        }
        if (seenProjectedUses.has(id)) {
          throw new SessionError(`Fork provider history contains duplicate tool use ${id}`);
        }
        seenProjectedUses.add(id);
        projectedUses.push(id);
        projectedPending.push(id);
      }
    }

    for (const block of results) {
      const id = block.tool_use_id;
      if (typeof id !== "string" || !id) {
        throw new SessionError(`Fork provider history contains a tool result without id`);
      }
      if (seenProjectedResults.has(id)) {
        throw new SessionError(`Fork provider history contains duplicate tool result ${id}`);
      }
      const expected = projectedPending.shift();
      if (!expected) {
        throw new SessionError(`Fork provider history contains an orphaned tool result (${id})`);
      }
      if (expected !== id) {
        throw new SessionError(
          `Fork provider history tool result order mismatch: expected ${expected}, received ${id}`,
        );
      }
      seenProjectedResults.add(id);
      projectedResults.push(id);
    }
  }
  if (projectedPending.length > 0) {
    throw new SessionError(
      `Fork cursor splits an unfinished tool round in provider history (${projectedPending[0]})`,
    );
  }

  const metadataUses: string[] = [];
  const metadataResults: string[] = [];
  const seenMetadataUses = new Set<string>();
  const seenMetadataResults = new Set<string>();
  const metadataPending: string[] = [];
  for (const event of events) {
    if (event.type !== "tool_use" && event.type !== "tool_result") continue;
    const id = event.data.toolCallId;
    if (typeof id !== "string" || !id) {
      throw new SessionError(`Fork snapshot contains a tool event without toolCallId`);
    }
    if (event.type === "tool_use") {
      if (seenMetadataUses.has(id)) {
        throw new SessionError(`Fork snapshot contains duplicate tool use metadata ${id}`);
      }
      seenMetadataUses.add(id);
      metadataUses.push(id);
      metadataPending.push(id);
      continue;
    }
    if (seenMetadataResults.has(id)) {
      throw new SessionError(`Fork snapshot contains duplicate tool result metadata ${id}`);
    }
    const expected = metadataPending.shift();
    if (!expected) {
      throw new SessionError(`Fork snapshot contains tool result metadata before use (${id})`);
    }
    if (expected !== id) {
      throw new SessionError(
        `Fork snapshot tool metadata order mismatch: expected ${expected}, received ${id}`,
      );
    }
    seenMetadataResults.add(id);
    metadataResults.push(id);
  }
  if (metadataPending.length > 0) {
    throw new SessionError(`Fork cursor splits unfinished tool metadata (${metadataPending[0]})`);
  }

  const sameIds = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every((id, index) => id === right[index]);
  if (!sameIds(projectedUses, metadataUses) || !sameIds(projectedResults, metadataResults)) {
    throw new SessionError(`Fork tool metadata does not match provider history`);
  }
}

function newestGoalTerminal(
  incoming: GoalTerminal | undefined,
  persisted: GoalTerminal | undefined,
): GoalTerminal | undefined {
  if (!incoming) return persisted;
  if (!persisted) return incoming;
  const incomingAt = incoming.terminatedAtMs ?? Number.NEGATIVE_INFINITY;
  const persistedAt = persisted.terminatedAtMs ?? Number.NEGATIVE_INFINITY;
  return incomingAt > persistedAt ? incoming : persisted;
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

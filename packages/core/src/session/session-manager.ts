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
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import type {
  SessionForkLineage,
  SessionState,
  SessionKind,
  SessionWorkspace,
  TokenUsage,
  TranscriptEvent,
  TranscriptEventType,
} from "../types.js";
import { Transcript } from "./transcript.js";
import { SessionError } from "../exceptions.js";
import {
  addCumulativeUsage,
  addTokenUsage,
  normalizeCumulativeUsageCounters,
} from "../engine/session-usage.js";
import {
  armGoalLifecycle,
  createGoalLifecycle,
  decodeGoalLifecycle,
  deriveLegacyGoalId,
  goalConfigFromLifecycle,
  isGoalLifecycleCurrent,
  isSameGoalVersion,
  mergeGoalTerminals,
  terminateGoalLifecycle,
  waitGoalLifecycle,
  type GoalConfig,
  type GoalLifecycleTerminalReason,
  type GoalLifecycleV1,
  type GoalTerminal,
  type PersistedGoalTerminationReason,
} from "../engine/goal.js";
import { lockSync } from "../utils/lockfile.js";
import { resolveCapabilities, type SessionWorkspaceCapability } from "../capabilities/index.js";

// Shared close epochs for SessionManager instances in this process. Concurrent
// Engines bind the same epoch; only close advances it. This intentionally does
// not claim cross-process/Worker protection.
const currentSessionCloseEpochs = new Map<string, number>();

const SESSION_STATE_LOCK_STALE_MS = 10_000;
const SESSION_STATE_LOCK_RETRY_DELAYS_MS = [5, 10, 20, 40] as const;
const syncSleepCell = new Int32Array(new SharedArrayBuffer(4));

type StateSaveAttempt =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "generation_conflict"
        | "lock_conflict"
        | "revision_conflict"
        | "kind_conflict"
        | "goal_schema_conflict";
    };

/** Non-Goal fields accepted by the generic latest-state merge path. */
export type SessionStateFieldPatch = Readonly<
  Partial<
    Omit<
      SessionState,
      "sessionId" | "goalLifecycle" | "activeGoal" | "goalTerminal" | "goalTerminals"
    >
  >
>;

export type GoalTerminalSaveOutcome = "persisted" | "obsolete" | "failed";

function sleepSync(ms: number): void {
  Atomics.wait(syncSleepCell, 0, 0, ms);
}

function lifecycleTerminalReason(
  reason: PersistedGoalTerminationReason,
): GoalLifecycleTerminalReason {
  return reason;
}

function newestLegacyTerminal(state: SessionState): GoalTerminal | undefined {
  return mergeGoalTerminals(state.goalTerminals, state.goalTerminal).at(-1);
}

function legacyTerminalMatchesGoal(terminal: GoalTerminal, goal: GoalConfig): boolean {
  if (terminal.goalId && goal.goalId) {
    return (
      terminal.goalId === goal.goalId &&
      Math.max(1, Math.floor(terminal.revision ?? 1)) ===
        Math.max(1, Math.floor(goal.revision ?? 1))
    );
  }
  return terminal.objective === goal.objective && terminal.setAtMs === goal.setAtMs;
}

/** Decode the canonical union or derive it once from legacy aliases. */
function hydrateGoalLifecycle(state: SessionState): SessionState {
  const hasCanonical = Object.prototype.hasOwnProperty.call(state, "goalLifecycle");
  const persistedLifecycle = (state as { goalLifecycle?: unknown }).goalLifecycle;
  let lifecycle: GoalLifecycleV1 | undefined;
  if (hasCanonical && persistedLifecycle !== undefined) {
    lifecycle = decodeGoalLifecycle(persistedLifecycle);
    if (!lifecycle) {
      throw new SessionError(
        `Session goal lifecycle is unsupported or corrupt for ${state.sessionId}`,
      );
    }
  } else if (state.activeGoal) {
    const active: GoalConfig = {
      ...state.activeGoal,
      goalId: state.activeGoal.goalId ?? deriveLegacyGoalId(state.sessionId, state.activeGoal),
      revision: Math.max(1, Math.floor(state.activeGoal.revision ?? 1)),
    };
    const terminal = mergeGoalTerminals(state.goalTerminals, state.goalTerminal).find((candidate) =>
      legacyTerminalMatchesGoal(candidate, active),
    );
    const base = createGoalLifecycle(active, active.paused === true ? "paused" : "active");
    lifecycle = terminal
      ? terminateGoalLifecycle(
          base,
          lifecycleTerminalReason(terminal.reason),
          terminal.terminatedAtMs ?? Date.now(),
        )
      : base;
  } else {
    const terminal = newestLegacyTerminal(state);
    if (terminal) {
      const goal: GoalConfig = {
        objective: terminal.objective,
        goalId:
          terminal.goalId ??
          deriveLegacyGoalId(state.sessionId, {
            objective: terminal.objective,
            setAtMs: terminal.setAtMs,
          }),
        revision: Math.max(1, Math.floor(terminal.revision ?? 1)),
        ...(terminal.setAtMs !== undefined ? { setAtMs: terminal.setAtMs } : {}),
      };
      lifecycle = terminateGoalLifecycle(
        createGoalLifecycle(goal, "active", terminal.terminatedAtMs ?? Date.now()),
        lifecycleTerminalReason(terminal.reason),
        terminal.terminatedAtMs ?? Date.now(),
      );
    }
  }

  if (lifecycle) state.goalLifecycle = lifecycle;
  else delete state.goalLifecycle;

  // Legacy aliases are migration inputs only. Never reconstruct them in RAM:
  // all runtime readers and writers consume the canonical lifecycle union.
  delete state.activeGoal;
  delete state.goalTerminal;
  delete state.goalTerminals;
  return state;
}

/** New files and runtime state contain only the canonical union. */
function stateForPersistence(state: SessionState): SessionState {
  const persisted = { ...state };
  delete persisted.activeGoal;
  delete persisted.goalTerminal;
  delete persisted.goalTerminals;
  return persisted;
}

/**
 * Temporary adapter for tests/older in-repo callers that still mutate the
 * hydrated aliases before calling whole-state saveState. Production Goal paths
 * use the domain methods below. The adapter never writes aliases to disk.
 */
function adoptCompatibilityGoalMutation(state: SessionState): void {
  const activeTouched = Object.prototype.hasOwnProperty.call(state, "activeGoal");
  const terminalTouched =
    Object.prototype.hasOwnProperty.call(state, "goalTerminal") ||
    Object.prototype.hasOwnProperty.call(state, "goalTerminals");
  if (!activeTouched && !terminalTouched) return;
  const lifecycle = decodeGoalLifecycle(state.goalLifecycle);
  const alias = state.activeGoal
    ? {
        ...state.activeGoal,
        goalId: state.activeGoal.goalId ?? deriveLegacyGoalId(state.sessionId, state.activeGoal),
        revision: Math.max(1, Math.floor(state.activeGoal.revision ?? 1)),
      }
    : undefined;
  const terminals = mergeGoalTerminals(state.goalTerminals, state.goalTerminal);

  if (!lifecycle) {
    if (alias) {
      state.goalLifecycle = createGoalLifecycle(alias, alias.paused === true ? "paused" : "active");
    }
    return;
  }

  if (alias) {
    const sameIdentity = lifecycle.goalId === alias.goalId;
    const sameRevision = lifecycle.revision === alias.revision;
    const matchingTerminal = terminals.find((terminal) =>
      legacyTerminalMatchesGoal(terminal, alias),
    );
    if (matchingTerminal) {
      const base = createGoalLifecycle(alias, alias.paused === true ? "paused" : "active");
      state.goalLifecycle = terminateGoalLifecycle(
        base,
        lifecycleTerminalReason(matchingTerminal.reason),
        matchingTerminal.terminatedAtMs ?? Date.now(),
      );
      return;
    }
    if (lifecycle.phase === "terminal" && sameIdentity && sameRevision) return;
    const canonicalGoal = goalConfigFromLifecycle(lifecycle);
    if (!sameIdentity || !sameRevision || !isSameGoalVersion(alias, canonicalGoal)) {
      state.goalLifecycle = createGoalLifecycle(alias, alias.paused === true ? "paused" : "active");
    }
    return;
  }

  const matchingTerminal = terminals.find((terminal) =>
    legacyTerminalMatchesGoal(terminal, goalConfigFromLifecycle(lifecycle)),
  );
  if (matchingTerminal && lifecycle.phase !== "terminal") {
    state.goalLifecycle = terminateGoalLifecycle(
      lifecycle,
      lifecycleTerminalReason(matchingTerminal.reason),
      matchingTerminal.terminatedAtMs ?? Date.now(),
    );
  }
}

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
  /** Hide this temporary fork from ordinary session lists and resume pickers. */
  ephemeral?: boolean;
}

export interface ForkSessionResult {
  bundle: SessionBundle;
  lineage: SessionForkLineage;
  copiedEventCount: number;
}

export interface SummaryForkOptions {
  targetSessionId?: string;
  fromEventId: string;
  toEventId: string;
  summary: string;
  sourceEventCount: number;
  estimatedTokens: number;
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
  "context_transfer",
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
      reason: "worktree_missing_branch_exists" | "workspace_capability_unavailable";
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
 * Runtime source of truth for sessions whose state must not outlive their UI
 * lifecycle. The explicit marker covers modern side forks; the qchat namespace
 * keeps historical/blank quick chats fail-closed if their older state file did
 * not contain the marker yet.
 */
export function isEphemeralSessionState(
  state: Pick<SessionState, "sessionId" | "ephemeral">,
): boolean {
  return state.ephemeral === true || state.sessionId.startsWith("qchat-");
}

function normalizedSessionKind(kind: unknown): SessionKind {
  return kind === "pet" ? "pet" : "work";
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

/** Canonical root for every persisted CodeShell session. */
export function sessionsRoot(): string {
  return join(codeShellHome(), "sessions");
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

/**
 * Read the session's persisted main-project root from the legacy `state.cwd`
 * field. The field name is part of the state.json compatibility contract and
 * must not be rewritten to `projectRoot`; `state.workspace.root` separately
 * identifies the current main/worktree execution root used on resume.
 */
export function sessionMainRoot(state: Pick<SessionState, "cwd">): string | undefined {
  return typeof state.cwd === "string" && state.cwd.length > 0 ? state.cwd : undefined;
}

async function validateResumeWorktreeRoot(
  root: string,
  workspaceCapability: SessionWorkspaceCapability,
): Promise<string | null> {
  if (!existsSync(root)) return "no longer exists";
  let stat;
  try {
    stat = lstatSync(root);
  } catch {
    return "no longer exists";
  }
  if (stat.isSymbolicLink()) return "is not a valid git worktree (symbolic link)";
  if (!stat.isDirectory()) return "is not a valid git worktree (not a directory)";
  if (!(await workspaceCapability.validateRoot(root))) return "is not a valid workspace root";
  return null;
}

export class SessionManager {
  private readonly sessionsDir: string;
  private readonly registeredCloseEpochs = new Map<string, number>();

  private readonly workspaceCapability?: SessionWorkspaceCapability;

  constructor(storageDir?: string, workspaceCapability?: SessionWorkspaceCapability) {
    this.sessionsDir = storageDir ?? sessionsRoot();
    this.workspaceCapability =
      workspaceCapability ??
      resolveCapabilities()
        .map((capability) => capability.sessionWorkspace)
        .find((candidate) => candidate !== undefined);
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
    kind: SessionKind = "work",
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
      kind,
      stateRevision: 0,
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
      ...(sessionId.startsWith("qchat-") ? { ephemeral: true } : {}),
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
      kind,
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
   * Cheap persisted-main-root probe — reads only state.json, NOT the transcript
   * (unlike resume()). This deliberately reads legacy `state.cwd`, not the
   * current `state.workspace.root`; callers use it as the stable main-project
   * fallback when a worktree is unavailable or is being released.
   */
  readSessionMainRoot(sessionId: string): string | undefined {
    try {
      assertSafeSessionId(sessionId);
    } catch {
      return undefined;
    }
    const stateFile = join(this.sessionsDir, sessionId, "state.json");
    if (!existsSync(stateFile)) return undefined;
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf-8")) as SessionState;
      return sessionMainRoot(state);
    } catch {
      return undefined;
    }
  }

  /** Cheap durable classification read. Legacy sessions are ordinary work sessions. */
  readSessionKind(sessionId: string): SessionKind | undefined {
    try {
      assertSafeSessionId(sessionId);
    } catch {
      return undefined;
    }
    const stateFile = join(this.sessionsDir, sessionId, "state.json");
    if (!existsSync(stateFile)) return undefined;
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf-8")) as SessionState;
      return normalizedSessionKind(state.kind);
    } catch {
      return undefined;
    }
  }

  /** @deprecated Use readSessionMainRoot; retained for public API compatibility. */
  readCwd(sessionId: string): string | undefined {
    return this.readSessionMainRoot(sessionId);
  }

  /** Disk-only direct-parent ACL metadata. Undefined means unprovable/corrupt. */
  readParentSessionId(sessionId: string): string | null | undefined {
    try {
      assertSafeSessionId(sessionId);
    } catch {
      return undefined;
    }
    const stateFile = join(this.sessionsDir, sessionId, "state.json");
    if (!existsSync(stateFile)) return undefined;
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf-8")) as SessionState;
      return state.parentSessionId === null || typeof state.parentSessionId === "string"
        ? state.parentSessionId
        : undefined;
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
      const mainRoot = sessionMainRoot(state);
      return mainRoot ? { root: mainRoot, kind: "main" } : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Persist the current session workspace pointer without changing legacy
   * `cwd`. P1 will teach ToolContext to resolve cwd from this field; for P0 it
   * is a safety pointer and resume breadcrumb.
   */
  setSessionWorkspace(sessionId: string, workspace: SessionWorkspace): number {
    assertSafeSessionId(sessionId);
    if (!isSessionWorkspace(workspace)) {
      throw new SessionError(`invalid workspace for session ${sessionId}`);
    }
    return this.updateSessionState(sessionId, { workspace });
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

    const mainRoot = sessionMainRoot(state);
    const legacyMain = mainRoot ? ({ root: mainRoot, kind: "main" } as const) : undefined;
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

    if (!this.workspaceCapability) {
      return {
        ok: false,
        cwd: mainRoot ?? workspace.root,
        workspace,
        reason: "workspace_capability_unavailable",
        message:
          `Session ${sessionId} uses a product workspace, but this host did not install ` +
          `the matching workspace capability. Install it before resuming this session.`,
      };
    }

    const invalidWorktreeReason = await validateResumeWorktreeRoot(
      workspace.root,
      this.workspaceCapability,
    );
    if (!invalidWorktreeReason) {
      return { ok: true, cwd: workspace.root, workspace, reason: "worktree" };
    }

    const branch = workspace.worktree?.branch;
    const fallbackMainRoot = mainRoot ?? workspace.root;
    if (
      branch &&
      existsSync(fallbackMainRoot) &&
      (await this.workspaceCapability.branchExists(fallbackMainRoot, branch))
    ) {
      return {
        ok: false,
        cwd: fallbackMainRoot,
        workspace,
        reason: "worktree_missing_branch_exists",
        message:
          `Session ${sessionId} is bound to worktree ${workspace.root}, but that directory ` +
          `${invalidWorktreeReason}. Branch ${branch} still exists; recreate the worktree at ` +
          `${workspace.worktree?.path ?? workspace.root} before resuming, or switch this session ` +
          `back to main explicitly.`,
      };
    }

    const fallback: SessionWorkspace = { root: fallbackMainRoot, kind: "main" };
    state.workspace = fallback;
    state.stateRevision = this.updateSessionState(sessionId, { workspace: fallback });
    return {
      ok: true,
      cwd: fallbackMainRoot,
      workspace: fallback,
      reason: "worktree_missing_branch_gone",
      message:
        `Session ${sessionId} was bound to worktree ${workspace.root}, but that directory ` +
        `${invalidWorktreeReason}${branch ? ` and branch ${branch} is gone` : ""}; fell back to main ` +
        `${fallbackMainRoot}. Re-run the request if you want to continue there.`,
    };
  }

  /**
   * Cheap "does this session have a persisted goal?" probe — reads only
   * state.json, NOT the transcript (like readSessionMainRoot). A persistent goal lives in
   * the canonical goalLifecycle union; it is never appended to the transcript as an event, so
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
      const state = hydrateGoalLifecycle(
        JSON.parse(readFileSync(stateFile, "utf-8")) as SessionState,
      );
      const lifecycle = state.goalLifecycle;
      if (!lifecycle || lifecycle.phase === "terminal") return undefined;
      const goal = goalConfigFromLifecycle(lifecycle);
      // Expose a concrete version even for legacy state.json so UI delete/edit
      // operations can send an expected fence instead of acting unconditionally.
      return {
        ...goal,
        goalId: goal.goalId ?? deriveLegacyGoalId(sessionId, goal),
        revision: goal.revision ?? 1,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Disk-only "wipe this session's persistent goal" — the counterpart to
   * readActiveGoal. Reads state.json, transitions the matching goalLifecycle
   * to terminal(user_cleared), and rewrites it through the field-level CAS.
   * Returns true only if a goal was actually
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
  clearActiveGoal(sessionId: string, expected?: { goalId?: string; revision?: number }): boolean {
    try {
      assertSafeSessionId(sessionId);
    } catch {
      return false;
    }
    for (let attempt = 0; attempt <= SESSION_STATE_LOCK_RETRY_DELAYS_MS.length; attempt++) {
      let state: SessionState;
      try {
        state = this.readPersistedState(sessionId);
      } catch {
        return false;
      }
      const lifecycle = state.goalLifecycle;
      if (!lifecycle || !isGoalLifecycleCurrent(lifecycle)) return false;
      const clearedGoal = goalConfigFromLifecycle(lifecycle);
      const revision = lifecycle.revision;
      if (expected?.goalId !== undefined && clearedGoal.goalId !== expected.goalId) return false;
      if (expected?.revision !== undefined && revision !== expected.revision) return false;

      const terminal = terminateGoalLifecycle(lifecycle, "user_cleared");
      if (!terminal) return false;
      state.goalLifecycle = terminal;
      hydrateGoalLifecycle(state);
      const result = this.saveStateAttempt(state);
      if (result.ok) return true;
      if (result.reason !== "revision_conflict") return false;
    }
    return false;
  }

  /**
   * Edit or pause/resume the currently active goal with an identity-checked,
   * field-level CAS. The goalId is preserved: editing the objective changes
   * the same user-owned goal rather than terminally cancelling it and arming a
   * replacement. A changed objective receives a fresh deadline anchor.
   *
   * Returns undefined when the session/goal is absent or the patch is invalid.
   * The returned state lets a live Engine rebase its in-memory bundle after
   * this control operation.
   */
  updateActiveGoal(
    sessionId: string,
    patch: {
      objective?: string;
      paused?: boolean;
      expectedGoalId?: string;
      expectedRevision?: number;
    },
  ): { goal: GoalConfig; stateRevision: number; state: SessionState } | undefined {
    try {
      assertSafeSessionId(sessionId);
    } catch {
      return undefined;
    }
    if (patch.objective === undefined && patch.paused === undefined) return undefined;
    if (patch.objective !== undefined && !patch.objective.trim()) return undefined;
    if (patch.paused !== undefined && typeof patch.paused !== "boolean") return undefined;

    let expectedGoalId = patch.expectedGoalId;
    let expectedRevision = patch.expectedRevision;
    for (let attempt = 0; attempt <= SESSION_STATE_LOCK_RETRY_DELAYS_MS.length; attempt++) {
      let state: SessionState;
      try {
        state = this.readPersistedState(sessionId);
      } catch {
        return undefined;
      }
      const lifecycle = state.goalLifecycle;
      if (!lifecycle || !isGoalLifecycleCurrent(lifecycle)) return undefined;
      const current = goalConfigFromLifecycle(lifecycle);
      const currentRevision = lifecycle.revision;
      expectedGoalId ??= current.goalId;
      expectedRevision ??= currentRevision;
      if (current.goalId !== expectedGoalId || currentRevision !== expectedRevision) {
        return undefined;
      }
      const objective = patch.objective?.trim() ?? current.objective;
      const objectiveChanged = objective !== current.objective;
      const goal: GoalConfig = {
        ...current,
        objective,
        revision: currentRevision + 1,
        ...(objectiveChanged ? { setAtMs: Date.now() } : {}),
      };
      if (patch.paused === true) goal.paused = true;
      else if (patch.paused === false) delete goal.paused;
      state.goalLifecycle = createGoalLifecycle(goal, goal.paused === true ? "paused" : "active");
      hydrateGoalLifecycle(state);

      const result = this.saveStateAttempt(state);
      if (result.ok) return { goal, stateRevision: state.stateRevision!, state };
      if (result.reason !== "revision_conflict") return undefined;
    }
    return undefined;
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
      state = hydrateGoalLifecycle(JSON.parse(readFileSync(stateFile, "utf-8")) as SessionState);
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

    state.kind = normalizedSessionKind(state.kind);
    state.status = "active";
    Object.assign(state, normalizeCumulativeUsageCounters(state, state.tokenUsage));

    return { state, transcript };
  }

  /**
   * Merge a field-level state update into the latest persisted snapshot.
   *
   * Unlike saveState(), callers do not supply a potentially stale whole-state
   * object. saveState serializes the read/revision-check/write section with the
   * per-session lock and returns the new persisted revision to the caller.
   */
  updateSessionState(sessionId: string, partial: SessionStateFieldPatch): number {
    assertSafeSessionId(sessionId);
    for (let attempt = 0; attempt <= SESSION_STATE_LOCK_RETRY_DELAYS_MS.length; attempt++) {
      const state = this.readPersistedState(sessionId);
      if (
        partial.kind !== undefined &&
        normalizedSessionKind(partial.kind) !== normalizedSessionKind(state.kind)
      ) {
        throw new SessionError(`Session kind is immutable for ${sessionId}`);
      }
      Object.assign(state, partial);
      state.sessionId = sessionId;
      const result = this.saveStateAttempt(state);
      if (result.ok) return state.stateRevision!;
      if (result.reason === "generation_conflict") {
        throw new SessionError(`Session generation conflict for ${sessionId}`);
      }
      if (result.reason === "lock_conflict") {
        throw new SessionError(`Session state lock contention for ${sessionId}`);
      }
      if (result.reason === "kind_conflict") {
        throw new SessionError(`Session kind is immutable for ${sessionId}`);
      }
      // A field-level update is explicitly authorized to merge into the newest
      // snapshot. Re-read it on the next iteration instead of treating its CAS
      // miss like a lock collision.
    }
    throw new SessionError(`Session state revision conflict for ${sessionId}`);
  }

  /**
   * Atomically add one billed auxiliary request to the latest source state.
   * This field-level read/add/write avoids publishing a detached stale state
   * snapshot and accounts prompt, completion, total, cache, and cost together.
   */
  recordAuxiliaryUsage(
    sessionId: string,
    usage: TokenUsage,
    costState?: Record<string, unknown>,
  ): void {
    assertSafeSessionId(sessionId);
    for (let attempt = 0; attempt <= SESSION_STATE_LOCK_RETRY_DELAYS_MS.length; attempt++) {
      const state = this.readPersistedState(sessionId);
      Object.assign(state, normalizeCumulativeUsageCounters(state, state.tokenUsage));
      Object.assign(state, addCumulativeUsage(state, usage));
      state.tokenUsage = addTokenUsage(state.tokenUsage, usage);
      if (costState !== undefined) state.costState = costState;
      const result = this.saveStateAttempt(state);
      if (result.ok) return;
      if (result.reason === "generation_conflict") {
        throw new SessionError(`Session generation conflict for ${sessionId}`);
      }
      if (result.reason === "lock_conflict") {
        throw new SessionError(`Session state lock contention for ${sessionId}`);
      }
      // Recompute the delta from the latest counters after a CAS miss so the
      // auxiliary usage is added exactly once without overwriting another writer.
    }
    throw new SessionError(`Session state revision conflict for ${sessionId}`);
  }

  /** @deprecated Compatibility fixture writer; runtime code must use domain updates. */
  saveState(state: SessionState, generation?: number): boolean {
    adoptCompatibilityGoalMutation(state);
    return this.saveStateAttempt(state, generation).ok;
  }

  /**
   * Persist one goal terminal transition without allowing a revision race to
   * resurrect that goal. This is always a Goal-domain update: read the newest
   * snapshot, transition only the matching lifecycle identity, then commit. A detached run
   * snapshot is never used as the write candidate,
   * so a successful terminal transition cannot publish stale summary/workspace
   * or accounting fields. Lock/generation conflicts remain distinct failures.
   */
  saveGoalTerminal(
    state: SessionState,
    goal: GoalConfig | undefined,
    reason: PersistedGoalTerminationReason,
  ): boolean {
    return this.saveGoalTerminalOutcome(state, goal, reason) !== "failed";
  }

  /**
   * Persist a terminal transition and distinguish a durable commit from a stale
   * run whose Goal identity has already been replaced. Callers may publish a
   * terminal event only for `persisted`.
   */
  saveGoalTerminalOutcome(
    state: SessionState,
    goal: GoalConfig | undefined,
    reason: PersistedGoalTerminationReason,
  ): GoalTerminalSaveOutcome {
    if (!goal) return "failed";
    const terminalGoal: GoalConfig = {
      ...goal,
      goalId: goal.goalId ?? deriveLegacyGoalId(state.sessionId, goal),
      revision: goal.revision ?? 1,
    };
    for (let attempt = 0; attempt <= SESSION_STATE_LOCK_RETRY_DELAYS_MS.length; attempt++) {
      const latest = this.readPersistedState(state.sessionId);
      const lifecycle = latest.goalLifecycle;
      if (!lifecycle) return "failed";
      if (
        lifecycle.goalId !== terminalGoal.goalId ||
        lifecycle.revision !== (terminalGoal.revision ?? 1)
      ) {
        // A newer replacement/edit already owns the canonical slot. The stale
        // run is obsolete, but must not mutate that newer goal.
        this.rebaseLiveState(state, latest);
        return "obsolete";
      }
      if (lifecycle.phase !== "terminal") {
        latest.goalLifecycle = terminateGoalLifecycle(lifecycle, lifecycleTerminalReason(reason));
        hydrateGoalLifecycle(latest);
      }
      const result = this.saveStateAttempt(latest);
      if (result.ok) {
        this.rebaseLiveState(state, latest);
        return "persisted";
      }
      if (result.reason !== "revision_conflict") return "failed";
    }
    return "failed";
  }

  /**
   * Arm or migrate one active goal as a Goal-domain update. The newest state is
   * always the write base, so unrelated fields written by another host survive.
   * Replacement is explicit and terminally closes the latest active identity;
   * a non-replacement write may only normalize the same legacy/current goal.
   */
  saveActiveGoal(
    state: SessionState,
    goal: GoalConfig,
    options: { replaceCurrent?: boolean } = {},
  ): boolean {
    const armedGoal: GoalConfig = {
      ...goal,
      goalId: goal.goalId ?? deriveLegacyGoalId(state.sessionId, goal),
      revision: goal.revision ?? 1,
    };
    for (let attempt = 0; attempt <= SESSION_STATE_LOCK_RETRY_DELAYS_MS.length; attempt++) {
      const latest = this.readPersistedState(state.sessionId);
      const current = latest.goalLifecycle;
      if (current) {
        const sameIdentity = current.goalId === armedGoal.goalId;
        const sameRevision = current.revision === (armedGoal.revision ?? 1);
        if (current.phase === "terminal" && sameIdentity && sameRevision) return false;
        if (current.phase !== "terminal" && !options.replaceCurrent && !sameIdentity) return false;
      }
      if (
        current?.phase === "waiting" &&
        current.goalId === armedGoal.goalId &&
        current.revision === (armedGoal.revision ?? 1)
      ) {
        latest.goalLifecycle = armGoalLifecycle(current) ?? current;
      } else {
        latest.goalLifecycle = createGoalLifecycle(
          armedGoal,
          armedGoal.paused === true ? "paused" : "active",
        );
      }
      hydrateGoalLifecycle(latest);
      const result = this.saveStateAttempt(latest);
      if (result.ok) {
        this.rebaseLiveState(state, latest);
        return true;
      }
      if (result.reason !== "revision_conflict") return false;
    }
    return false;
  }

  /** Persist active → waiting only for the expected concrete Goal version. */
  markGoalWaiting(state: SessionState, goal: GoalConfig): boolean {
    const expectedGoalId = goal.goalId ?? deriveLegacyGoalId(state.sessionId, goal);
    const expectedRevision = Math.max(1, Math.floor(goal.revision ?? 1));
    for (let attempt = 0; attempt <= SESSION_STATE_LOCK_RETRY_DELAYS_MS.length; attempt++) {
      const latest = this.readPersistedState(state.sessionId);
      const lifecycle = latest.goalLifecycle;
      if (!lifecycle) return false;
      if (lifecycle.goalId !== expectedGoalId || lifecycle.revision !== expectedRevision) {
        this.rebaseLiveState(state, latest);
        return false;
      }
      if (lifecycle.phase === "waiting") {
        this.rebaseLiveState(state, latest);
        return true;
      }
      const waiting = waitGoalLifecycle(lifecycle);
      if (!waiting) return false;
      latest.goalLifecycle = waiting;
      hydrateGoalLifecycle(latest);
      const result = this.saveStateAttempt(latest);
      if (result.ok) {
        this.rebaseLiveState(state, latest);
        return true;
      }
      if (result.reason !== "revision_conflict") return false;
    }
    return false;
  }

  /** Drop a matching active goal only when its terminal identity is durable. */
  clearTerminatedActiveGoal(state: SessionState, goal: GoalConfig): boolean {
    for (let attempt = 0; attempt <= SESSION_STATE_LOCK_RETRY_DELAYS_MS.length; attempt++) {
      const latest = this.readPersistedState(state.sessionId);
      const expectedGoalId = goal.goalId ?? deriveLegacyGoalId(state.sessionId, goal);
      const lifecycle = latest.goalLifecycle;
      if (
        !lifecycle ||
        lifecycle.goalId !== expectedGoalId ||
        lifecycle.revision !== Math.max(1, Math.floor(goal.revision ?? 1))
      ) {
        this.rebaseLiveState(state, latest);
        return true;
      }
      if (lifecycle.phase !== "terminal") return false;
      this.rebaseLiveState(state, latest);
      return true;
    }
    return false;
  }

  /**
   * Commit only the fields owned by a live run. The detached `state` object is
   * used solely as a live-view target for the returned revision; it is never
   * serialized wholesale. This prevents a Goal/workspace/title domain write
   * from authorizing a later stale metadata overwrite.
   */
  saveStateOrUpdateFields(state: SessionState, partial: SessionStateFieldPatch): boolean {
    try {
      const stateRevision = this.updateSessionState(state.sessionId, partial);
      Object.assign(state, partial, { stateRevision });
      return true;
    } catch {
      return false;
    }
  }

  private saveStateAttempt(state: SessionState, generation?: number): StateSaveAttempt {
    // state.sessionId could come from a deserialized state.json that was
    // tampered with on disk. Validate before joining.
    assertSafeSessionId(state.sessionId);
    try {
      hydrateGoalLifecycle(state);
    } catch {
      return { ok: false, reason: "goal_schema_conflict" };
    }
    const writerGeneration = generation ?? this.registeredCloseEpochs.get(state.sessionId);
    if (
      writerGeneration !== undefined &&
      (currentSessionCloseEpochs.get(this.generationKey(state.sessionId)) ?? 0) !== writerGeneration
    ) {
      return { ok: false, reason: "generation_conflict" };
    }

    const sessionDir = join(this.sessionsDir, state.sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const target = join(sessionDir, "state.json");
    // proper-lockfile uses an atomic mkdir lock plus an mtime lease. It
    // recovers crash-orphaned locks after `stale` and refreshes live locks so a
    // slow writer is not stolen. Short genuine contention gets bounded retry.
    const release = this.acquireStateLock(target);
    if (!release) return { ok: false, reason: "lock_conflict" };

    try {
      let persisted: SessionState | undefined;
      if (existsSync(target)) {
        try {
          persisted = hydrateGoalLifecycle(
            JSON.parse(readFileSync(target, "utf-8")) as SessionState,
          );
        } catch {
          return { ok: false, reason: "goal_schema_conflict" };
        }
      }

      const incomingKind = normalizedSessionKind(state.kind);
      const persistedKind = persisted ? normalizedSessionKind(persisted.kind) : incomingKind;
      if (persisted && incomingKind !== persistedKind) {
        return { ok: false, reason: "kind_conflict" };
      }
      state.kind = persistedKind;

      const persistedRevision = persisted?.stateRevision;
      const incomingRevision = state.stateRevision;
      const revisionsMatch =
        persisted === undefined ||
        (persistedRevision === undefined && incomingRevision === undefined) ||
        (typeof persistedRevision === "number" && incomingRevision === persistedRevision);
      if (!revisionsMatch) return { ok: false, reason: "revision_conflict" };

      // A title can be generated by a field-level writer while this bundle is
      // live. Preserve it when the incoming object never owned the field.
      if (persisted?.title !== undefined && !("title" in state)) {
        state.title = persisted.title;
      }

      state.stateRevision = (persistedRevision ?? incomingRevision ?? 0) + 1;
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(stateForPersistence(state), null, 2), "utf-8");
      renameSync(tmp, target);
      return { ok: true };
    } finally {
      try {
        release();
      } catch {
        // A compromised/reaped lease must not mask the persistence result.
      }
    }
  }

  private acquireStateLock(target: string): (() => void) | undefined {
    const lockPath = `${target}.lock`;
    for (let attempt = 0; attempt <= SESSION_STATE_LOCK_RETRY_DELAYS_MS.length; attempt++) {
      if (!this.prepareLegacyStateLock(lockPath)) {
        const delay = SESSION_STATE_LOCK_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) return undefined;
        sleepSync(delay);
        continue;
      }
      try {
        return lockSync(target, {
          stale: SESSION_STATE_LOCK_STALE_MS,
          update: SESSION_STATE_LOCK_STALE_MS / 2,
          retries: 0,
          realpath: false,
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ELOCKED" && code !== "EEXIST") throw err;
        const delay = SESSION_STATE_LOCK_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) return undefined;
        sleepSync(delay);
      }
    }
    return undefined;
  }

  /** Recover only the old implementation's regular-file orphan lock. */
  private prepareLegacyStateLock(lockPath: string): boolean {
    if (!existsSync(lockPath)) return true;
    let stat;
    try {
      stat = lstatSync(lockPath);
    } catch {
      return true;
    }
    if (stat.isDirectory()) return true;
    if (Date.now() - stat.mtimeMs <= SESSION_STATE_LOCK_STALE_MS) return false;
    try {
      rmSync(lockPath, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  private readPersistedState(sessionId: string): SessionState {
    const stateFile = join(this.sessionsDir, sessionId, "state.json");
    if (!existsSync(stateFile)) {
      throw new SessionError(`Session state file not found: ${sessionId}`);
    }
    try {
      return hydrateGoalLifecycle(JSON.parse(readFileSync(stateFile, "utf-8")) as SessionState);
    } catch (err) {
      throw new SessionError(
        `Session state is corrupt for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private rebaseLiveState(live: SessionState, persisted: SessionState): void {
    for (const key of Object.keys(live) as Array<keyof SessionState>) {
      if (!(key in persisted)) delete live[key];
    }
    Object.assign(live, persisted);
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
    if (options.ephemeral === true) state.ephemeral = true;
    const events = buildForkTranscript(snapshot.copiedEvents, state);
    const bundle = this.publishSessionAtomically(targetSessionId, state, events);
    return { bundle, lineage, copiedEventCount: snapshot.copiedEvents.length };
  }

  /** Freeze and validate an inclusive source range before any model call. */
  selectContextPackage(
    sourceSessionId: string,
    range: { fromEventId: string; toEventId: string },
  ): ReturnType<typeof Transcript.selectContextRange> {
    assertSafeSessionId(sourceSessionId);
    const transcriptFile = join(this.sessionsDir, sourceSessionId, "transcript.jsonl");
    const stateFile = join(this.sessionsDir, sourceSessionId, "state.json");
    if (!existsSync(stateFile)) throw new SessionError(`Session not found: ${sourceSessionId}`);
    const parsed = Transcript.readEvents(transcriptFile);
    if (parsed.malformedLineCount > 0) {
      throw new SessionError(
        `Session transcript is malformed for ${sourceSessionId}: ${parsed.malformedLineCount} invalid line(s)`,
      );
    }
    return Transcript.selectContextRange(parsed.events, range);
  }

  /** Publish a summary-only top-level fork after summarization has succeeded. */
  createSummaryFork(sourceSessionId: string, options: SummaryForkOptions): ForkSessionResult {
    assertSafeSessionId(sourceSessionId);
    if (options.targetSessionId !== undefined) assertSafeSessionId(options.targetSessionId);
    if (!options.fromEventId || !options.toEventId) {
      throw new SessionError("Summary fork requires a closed source event range");
    }
    if (!options.summary.trim())
      throw new SessionError("Summary fork requires a non-empty summary");
    const source = this.resume(sourceSessionId);
    const targetSessionId = options.targetSessionId ?? nanoid(16);
    const createdAt = Date.now();
    const lineage: SessionForkLineage = {
      sessionId: sourceSessionId,
      mode: "summary",
      fromEventId: options.fromEventId,
      throughEventId: options.toEventId,
      sourceEventCount: options.sourceEventCount,
      createdAt,
    };
    const state = buildForkState(source.state, targetSessionId, lineage, createdAt);
    const [meta] = buildForkTranscript([], state);
    const summaryEvent: TranscriptEvent = {
      id: nanoid(12),
      type: "context_transfer",
      timestamp: createdAt,
      turnNumber: 0,
      data: {
        summary: options.summary,
        sourceRange: {
          sessionId: sourceSessionId,
          fromEventId: options.fromEventId,
          toEventId: options.toEventId,
        },
        sourceEventCount: options.sourceEventCount,
        estimatedTokens: options.estimatedTokens,
        summaryVersion: 1,
        summaryHash: createHash("sha256").update(options.summary).digest("hex"),
      },
    };
    const bundle = this.publishSessionAtomically(targetSessionId, state, [meta!, summaryEvent]);
    return { bundle, lineage, copiedEventCount: 0 };
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
      // last run completed naturally. A modern schema marker without a cursor
      // means persistence was degraded, so even status=completed must not use
      // the tail. Active/error/abort tails may be partial as well.
      frozen =
        sourceState.completedSnapshotVersion === undefined && sourceState.status === "completed"
          ? sourceEvents
          : [];
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
      .filter(
        (d) => d.isDirectory() && !d.name.startsWith(".pending-") && !d.name.startsWith("qchat-"),
      )
      .map((d) => d.name);

    // Two-pass scan. Pass 1: cheap stat to find each session's
    // lastActiveAt and sort. Pass 2 opens state.json in that order until it
    // finds `limit` non-ephemeral winners, then tails only those transcripts
    // for previews. With ~1 k sessions on disk the difference is ~1 s
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
    const sessions: SessionListEntry[] = [];
    for (const c of candidates) {
      if (sessions.length >= limit) break;
      try {
        const state = JSON.parse(readFileSync(c.stateFile, "utf-8")) as SessionState;
        if (isEphemeralSessionState(state)) continue;
        state.kind = normalizedSessionKind(state.kind);
        if (state.kind === "pet") continue;
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
    kind: "work",
    stateRevision: 0,
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

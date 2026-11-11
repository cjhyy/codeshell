import type { Dirent } from "node:fs";
/**
 * Session lifecycle manager.
 *
 * Owns Session creation/resume, the process-local (ephemeral) bundle registry,
 * close epochs and closing-run finalizers, the state.json CAS writer and its
 * domain updates (run, usage, workspace, Goal), and fork publication. Storage
 * roots/id validation, state-field interpretation, Goal alias migration,
 * state-file locking, fork snapshot rules and listing live in sibling
 * session-*.ts modules and are re-exported here for existing callers.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  lstatSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { nanoid } from "nanoid";
import type {
  SessionForkLineage,
  SessionState,
  SubAgentContinuation,
  SessionKind,
  SessionWorkspace,
  TokenUsage,
  TranscriptEvent,
} from "../types.js";
import { Transcript } from "./transcript.js";
import { parseSubAgentContinuation } from "./subagent-continuation.js";
import { SessionError } from "../exceptions.js";
import { addCumulativeUsage, addTokenUsage, normalizeCumulativeUsageCounters } from "./usage.js";
import {
  addGoalProgress,
  armGoalLifecycle,
  carryGoalProgress,
  createGoalLifecycle,
  deriveLegacyGoalId,
  goalConfigFromLifecycle,
  isGoalLifecycleCurrent,
  terminateGoalLifecycle,
  goalProgressSnapshot,
  waitGoalLifecycle,
  type GoalConfig,
  type GoalProgressSnapshot,
  type GoalWaitKind,
  type PersistedGoalTerminationReason,
} from "../goal/lifecycle.js";
import { iterateProfileReferences } from "./profile-references.js";
import type { SessionWorkspaceCapability } from "../capabilities/index.js";
import { assertSafeSessionId, sessionsRoot } from "./session-paths.js";
import {
  isEphemeralSessionState,
  isSessionWorkspace,
  normalizedSessionKind,
  sessionMainRoot,
  validateResumeWorktreeRoot,
} from "./session-state-shape.js";
import {
  adoptCompatibilityGoalMutation,
  hydrateGoalLifecycle,
  lifecycleTerminalReason,
  stateForPersistence,
} from "./session-goal-state.js";
import {
  SESSION_STATE_LOCK_RETRY_DELAYS_MS,
  acquireStateLock,
  preservePersistedRecoveryFields,
  rebaseLiveState,
  writeStateAtomically as writeStateFileAtomically,
  type StateSaveAttempt,
} from "./session-state-file.js";
import {
  buildForkState,
  buildForkTranscript,
  buildSummaryTransferEvent,
  cleanupStaleForkStaging,
  freezeForkSnapshot,
  type FrozenForkSnapshot,
} from "./session-fork.js";
import { listSessionEntries, type SessionListEntry } from "./session-list.js";

export { assertSafeSessionId, codeShellHome, sessionsRoot } from "./session-paths.js";
export { isEphemeralSessionState, sessionMainRoot } from "./session-state-shape.js";
export { buildForkState, buildForkTranscript } from "./session-fork.js";
export { listSessionEntries, type SessionListEntry } from "./session-list.js";

// Shared close epochs for SessionManager instances in this process. Concurrent
// Engines bind the same epoch; only close advances it. This intentionally does
// not claim cross-process/Worker protection.
const currentSessionCloseEpochs = new Map<string, number>();
const issuedClosingRunFinalizers = new Map<string, number>();

/** Non-Goal fields accepted by the generic latest-state merge path. */
export type SessionStateFieldPatch = Readonly<
  Partial<
    Omit<
      SessionState,
      "sessionId" | "goalLifecycle" | "activeGoal" | "goalTerminal" | "goalTerminals"
    >
  >
>;

const RUN_FINAL_STATE_FIELDS = [
  "status",
  "lastCompletionKind",
  "turnCount",
  "turnSeq",
  "tokenUsage",
  "toolSelection",
  "cacheUsageVersion",
  "cumulativePromptTokens",
  "cumulativeCacheReadTokens",
  "cumulativeCacheCreationTokens",
  "contextUsageAnchor",
  "costState",
  "completedSnapshotVersion",
  "completedThroughEventId",
] as const satisfies readonly (keyof SessionState)[];

/** Closing owners can publish final run fields, never detached domain metadata. */
export type SessionRunFinalStatePatch = Readonly<
  Pick<SessionState, (typeof RUN_FINAL_STATE_FIELDS)[number]>
>;

export interface SessionClosingRunFinalizer {
  readonly runId: string;
  commit: (
    readFinal: () => {
      fields: SessionRunFinalStatePatch;
      usageDelta: TokenUsage;
      cacheUsageDelta?: TokenUsage;
      previousContextUsageAnchor: SessionState["contextUsageAnchor"];
    },
  ) => boolean;
}

export type GoalTerminalSaveOutcome = "persisted" | "obsolete" | "failed";

export interface SessionBundle {
  state: SessionState;
  transcript: Transcript;
}

// Quick Chat sessions are intentionally process-local. SessionManager
// instances are created per Engine, so this registry lives at module scope to
// let a fork created by one Engine be resumed by another without touching
// disk. The storage root remains part of the key to preserve identity/data-root
// isolation.
const processLocalSessionBundles = new Map<string, SessionBundle>();

export interface ForkSessionOptions {
  targetSessionId?: string;
  /** Inclusive source event cursor; omitted means the frozen transcript tail. */
  throughEventId?: string;
  /** `completed` is the interrupted snapshot used by ephemeral side chats. */
  snapshotMode?: "tail" | "completed";
  /** Keep this temporary fork in process memory only. */
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

export class SessionManager {
  private readonly sessionsDir: string;
  private readonly registeredCloseEpochs = new Map<string, number>();

  private readonly workspaceCapability?: SessionWorkspaceCapability;

  constructor(storageDir?: string, workspaceCapability?: SessionWorkspaceCapability) {
    this.sessionsDir = storageDir ?? sessionsRoot();
    // No process-global fallback: the workspace capability comes from the
    // owner's compiled composition (Engine passes it explicitly).
    this.workspaceCapability = workspaceCapability;
    mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(this.sessionsDir, 0o700);
    cleanupStaleForkStaging(this.sessionsDir);
  }

  private processLocalKey(sessionId: string): string {
    return `${this.sessionsDir}\0${sessionId}`;
  }

  private processLocalBundle(sessionId: string): SessionBundle | undefined {
    return processLocalSessionBundles.get(this.processLocalKey(sessionId));
  }

  private storeProcessLocalBundle(bundle: SessionBundle): void {
    processLocalSessionBundles.set(this.processLocalKey(bundle.state.sessionId), {
      state: structuredClone(bundle.state),
      transcript: bundle.transcript,
    });
  }

  /** Forget a Quick Chat/side-chat bundle immediately; nothing remains on disk. */
  forgetEphemeralSession(sessionId: string): boolean {
    assertSafeSessionId(sessionId);
    const bundle = this.processLocalBundle(sessionId);
    if (!bundle || !isEphemeralSessionState(bundle.state)) return false;
    return processLocalSessionBundles.delete(this.processLocalKey(sessionId));
  }

  /** Bind one Engine/session pair to the current close epoch without advancing it. */
  registerSessionGeneration(sessionId: string): number {
    assertSafeSessionId(sessionId);
    const key = this.generationKey(sessionId);
    const generation = currentSessionCloseEpochs.get(key) ?? 0;
    this.registeredCloseEpochs.set(sessionId, generation);
    return generation;
  }

  /** A registered writer must stop ordinary writes after its Session closes. */
  isSessionGenerationCurrent(sessionId: string): boolean {
    assertSafeSessionId(sessionId);
    const generation = this.registeredCloseEpochs.get(sessionId);
    return (
      generation !== undefined &&
      generation === (currentSessionCloseEpochs.get(this.generationKey(sessionId)) ?? 0)
    );
  }

  /** Advance the close epoch once before close waits for the old run to settle. */
  incrementSessionGeneration(sessionId: string): number {
    assertSafeSessionId(sessionId);
    const key = this.generationKey(sessionId);
    const next = (currentSessionCloseEpochs.get(key) ?? 0) + 1;
    currentSessionCloseEpochs.set(key, next);
    issuedClosingRunFinalizers.delete(key);
    return next;
  }

  /**
   * Give the closing owner one final merge after the revoked run has settled.
   * This does not rebind this manager: all its ordinary writers remain fenced.
   * The lease expires on another close or a durable run-identity replacement.
   */
  createClosingRunFinalizer(
    sessionId: string,
    closingEpoch: number,
    expectedRunId: string,
  ): SessionClosingRunFinalizer | undefined {
    assertSafeSessionId(sessionId);
    const key = this.generationKey(sessionId);
    if (
      this.registeredCloseEpochs.get(sessionId) !== closingEpoch - 1 ||
      currentSessionCloseEpochs.get(key) !== closingEpoch
    ) {
      return undefined;
    }
    const initial = this.readSessionState(sessionId);
    if (!expectedRunId || initial?.runId !== expectedRunId) return undefined;
    if (issuedClosingRunFinalizers.get(key) === closingEpoch) return undefined;
    issuedClosingRunFinalizers.set(key, closingEpoch);
    const runId = expectedRunId;
    let consumed = false;
    return {
      runId,
      commit: (readFinal) => {
        if (consumed) return false;
        consumed = true;
        try {
          for (let attempt = 0; attempt <= SESSION_STATE_LOCK_RETRY_DELAYS_MS.length; attempt++) {
            if (currentSessionCloseEpochs.get(key) !== closingEpoch) return false;
            const latest = this.readPersistedState(sessionId);
            if (latest.runId !== runId) return false;
            // Read after settlement and on every CAS retry, including a fresh
            // ledger serialization. Do not freeze usage/cost before end hooks.
            const {
              fields: partial,
              usageDelta,
              previousContextUsageAnchor,
              cacheUsageDelta = { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            } = readFinal();
            if (typeof partial.status !== "string" || partial.status === "active") return false;
            // Project at runtime too: a cast/JavaScript caller cannot smuggle
            // domain metadata or a new run identity through the narrow lease.
            const fields = Object.fromEntries(
              RUN_FINAL_STATE_FIELDS.map((field) => [field, structuredClone(partial[field])]),
            );
            // Older closing callers have no loading snapshot; retain the latest hints.
            fields.toolSelection ??= latest.toolSelection;
            if (
              [...Object.values(usageDelta), ...Object.values(cacheUsageDelta)].some(
                (n) => !Number.isFinite(n) || n < 0,
              )
            )
              return false;
            // This delta belongs only to the revoked run's uncommitted usage.
            // Other owners' pre/post-close auxiliary usage stays in latest.
            fields.tokenUsage = addTokenUsage(latest.tokenUsage, usageDelta);
            Object.assign(
              fields,
              addCumulativeUsage(
                normalizeCumulativeUsageCounters(latest, latest.tokenUsage),
                cacheUsageDelta,
              ),
            );
            // An independent owner may have advanced context before close too.
            // Only replace the exact anchor our Engine last successfully wrote.
            if (!isDeepStrictEqual(latest.contextUsageAnchor, previousContextUsageAnchor)) {
              delete fields.contextUsageAnchor;
            }
            Object.assign(latest, fields);
            const result = this.saveStateAttempt(latest, closingEpoch);
            if (result.ok) return true;
            if (result.reason !== "revision_conflict") return false;
            // A domain writer won the CAS. Re-read it and recheck run identity;
            // never restore a stale snapshot merely to publish terminal fields.
          }
        } catch {
          return false;
        }
        return false;
      },
    };
  }

  /**
   * Create a session. `qchat-` sessions stay process-local; ordinary sessions
   * materialize state.json + transcript.jsonl before return.
   */
  create(
    cwd: string,
    model: string,
    provider: string,
    explicitSessionId?: string,
    parentSessionId?: string | null,
    origin?: import("../types.js").SessionOrigin,
    kind: SessionKind = "work",
    ephemeral = false,
    subAgentContinuation?: SubAgentContinuation,
  ): SessionBundle {
    // External callers may pass any string; nanoid output is trusted. Either
    // way the ID gets joined into a filesystem path, so the public entry
    // point validates before that join.
    if (explicitSessionId !== undefined) assertSafeSessionId(explicitSessionId);
    const continuation =
      subAgentContinuation === undefined
        ? undefined
        : parseSubAgentContinuation(subAgentContinuation, parentSessionId);
    if (subAgentContinuation !== undefined && !continuation) {
      throw new SessionError("Invalid sub-agent continuation metadata or parent ownership");
    }
    const sessionId = explicitSessionId ?? nanoid(16);
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
      cacheUsageVersion: 1,
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
      ...(continuation ? { subAgentContinuation: continuation } : {}),
      ...(ephemeral || sessionId.startsWith("qchat-") ? { ephemeral: true } : {}),
      ...(origin ? { origin } : {}),
    };

    if (isEphemeralSessionState(state)) {
      if (this.processLocalBundle(sessionId)) {
        throw new SessionError(`Session already exists: ${sessionId}`);
      }
      const transcript = Transcript.inMemory(sessionId);
      transcript.append("session_meta", {
        sessionId,
        cwd,
        model,
        provider,
        startedAt: state.startedAt,
        kind,
      });
      if (transcript.flushFailed()) {
        throw new SessionError(`Failed to persist initial transcript for ${sessionId}`);
      }
      const bundle = { state, transcript };
      this.storeProcessLocalBundle(bundle);
      return bundle;
    }

    const sessionDir = join(this.sessionsDir, sessionId);
    try {
      mkdirSync(sessionDir, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new SessionError(`Session already exists: ${sessionId}`);
      }
      throw err;
    }

    // Atomic write (tmp+rename) like saveState, so a crash during this one-time
    // create can't leave a torn state.json that resume() then fails to parse.
    try {
      const stateTarget = join(sessionDir, "state.json");
      this.writeStateAtomically(stateTarget, state, "create");

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
    } catch (error) {
      // A failed first materialization must not reserve the session id forever
      // with an empty/partial directory.
      rmSync(sessionDir, { recursive: true, force: true });
      throw error;
    }
  }

  /** Whether a persisted or process-local session exists. */
  exists(sessionId: string): boolean {
    // exists() is a probe — callers use it to decide between resume and
    // create-with-explicit-sid. Treat an invalid id as "not present"
    // rather than letting the traversal-shaped string reach existsSync.
    try {
      assertSafeSessionId(sessionId);
    } catch {
      return false;
    }
    if (this.processLocalBundle(sessionId)) return true;
    // Never resurrect a legacy Quick Chat directory after the process-local
    // record has expired.
    if (sessionId.startsWith("qchat-")) return false;
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
    const processLocal = this.processLocalBundle(sessionId);
    if (processLocal) return sessionMainRoot(processLocal.state);
    if (sessionId.startsWith("qchat-")) return undefined;
    const stateFile = join(this.sessionsDir, sessionId, "state.json");
    if (!existsSync(stateFile)) return undefined;
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf-8")) as SessionState;
      return sessionMainRoot(state);
    } catch {
      return undefined;
    }
  }

  /** Cheap durable project-binding read; absent for legacy/no-repo Sessions. */
  readSessionProjectBinding(
    sessionId: string,
  ): import("../types.js").SessionProjectBinding | undefined {
    try {
      assertSafeSessionId(sessionId);
      const processLocal = this.processLocalBundle(sessionId);
      const state = processLocal
        ? processLocal.state
        : sessionId.startsWith("qchat-")
          ? undefined
          : (JSON.parse(
              readFileSync(join(this.sessionsDir, sessionId, "state.json"), "utf-8"),
            ) as SessionState);
      const project = state?.project;
      return project &&
        typeof project.projectId === "string" &&
        project.projectId.length > 0 &&
        typeof project.mainRootId === "string" &&
        project.mainRootId.length > 0
        ? { projectId: project.projectId, mainRootId: project.mainRootId }
        : undefined;
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
    const processLocal = this.processLocalBundle(sessionId);
    if (processLocal) return normalizedSessionKind(processLocal.state.kind);
    if (sessionId.startsWith("qchat-")) return undefined;
    const stateFile = join(this.sessionsDir, sessionId, "state.json");
    if (!existsSync(stateFile)) return undefined;
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf-8")) as SessionState;
      return normalizedSessionKind(state.kind);
    } catch {
      return undefined;
    }
  }

  /** Cheap durable digital-human binding read. */
  readSessionWorkspaceProfile(sessionId: string): string | undefined {
    try {
      assertSafeSessionId(sessionId);
      const processLocal = this.processLocalBundle(sessionId);
      if (processLocal) {
        const profile = processLocal.state.workspaceProfile;
        return typeof profile === "string" && profile ? profile : undefined;
      }
      if (sessionId.startsWith("qchat-")) return undefined;
      const stateFile = join(this.sessionsDir, sessionId, "state.json");
      if (!existsSync(stateFile)) return undefined;
      const state = JSON.parse(readFileSync(stateFile, "utf-8")) as SessionState;
      return typeof state.workspaceProfile === "string" && state.workspaceProfile
        ? state.workspaceProfile
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Clear this binding only while its latest durable value still matches. */
  clearSessionWorkspaceProfile(sessionId: string, expectedProfile: string): boolean {
    let cleared = false;
    this.mergeSessionState(sessionId, (current) => {
      cleared = current.workspaceProfile === expectedProfile;
      return cleared ? { workspaceProfile: undefined } : undefined;
    });
    return cleared;
  }

  /** Visit all durable profile references without blocking on a synchronous full scan. */
  iterateSessionIdsByWorkspaceProfile(
    profileName: string,
    options: { includeArchived?: boolean } = {},
  ): AsyncGenerator<string> {
    return iterateProfileReferences(this.sessionsDir, profileName, options, assertSafeSessionId);
  }

  /**
   * Find durable Sessions currently bound to one digital-human profile without loading
   * transcripts. Used by profile deletion guards so a reusable/historical
   * Session cannot be left permanently unresumable.
   */
  /**
   * Sessions whose state pins this digital human.
   *
   * `includeArchived: false` drops archived Sessions: they are closed history,
   * not a live binding, so they should not block deleting the profile. A
   * dangling name is already handled downstream — resolveActiveWorkspaceProfile
   * logs `profile.active_missing_from_library` and returns undefined.
   */
  findSessionIdsByWorkspaceProfile(
    profileName: string,
    limit = 20,
    options: { includeArchived?: boolean } = {},
  ): string[] {
    const includeArchived = options.includeArchived !== false;
    const target = typeof profileName === "string" ? profileName.trim() : "";
    if (!target || target.length > 64 || limit <= 0) return [];
    const cap = Math.max(1, Math.min(100, Math.floor(limit)));
    let entries: Dirent[];
    try {
      entries = readdirSync(this.sessionsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const matches: string[] = [];
    for (const entry of entries) {
      if (matches.length >= cap) break;
      if (
        !entry.isDirectory() ||
        entry.name.startsWith(".pending-") ||
        entry.name.startsWith("qchat-")
      ) {
        continue;
      }
      try {
        assertSafeSessionId(entry.name);
        const stateFile = join(this.sessionsDir, entry.name, "state.json");
        const info = lstatSync(stateFile);
        if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024) continue;
        const state = JSON.parse(readFileSync(stateFile, "utf-8")) as {
          workspaceProfile?: unknown;
          archivedAt?: unknown;
        };
        if (state.workspaceProfile !== target) continue;
        if (!includeArchived && typeof state.archivedAt === "number") continue;
        matches.push(entry.name);
      } catch {
        // Corrupt or unsafe Sessions are isolated from the deletion decision.
      }
    }
    return matches.sort();
  }

  /** @deprecated Use readSessionMainRoot; retained for public API compatibility. */
  readCwd(sessionId: string): string | undefined {
    return this.readSessionMainRoot(sessionId);
  }

  /** Direct-parent ACL metadata. Undefined means unprovable/corrupt. */
  readParentSessionId(sessionId: string): string | null | undefined {
    try {
      assertSafeSessionId(sessionId);
    } catch {
      return undefined;
    }
    const processLocal = this.processLocalBundle(sessionId);
    if (processLocal) {
      const parent = processLocal.state.parentSessionId;
      return parent === null || typeof parent === "string" ? parent : undefined;
    }
    if (sessionId.startsWith("qchat-")) return undefined;
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

  /** Validated frozen child scope. Missing/corrupt snapshots cannot authorize resume. */
  readSubAgentContinuation(sessionId: string): SubAgentContinuation | undefined {
    try {
      const state = this.readSessionState(sessionId);
      return state
        ? parseSubAgentContinuation(state.subAgentContinuation, state.parentSessionId)
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Workspace pointer reader. Legacy sessions written before
   * `workspace` existed are treated as main-workspace sessions rooted at
   * `state.cwd`; the read is intentionally non-mutating.
   */
  getSessionWorkspace(sessionId: string): SessionWorkspace | undefined {
    try {
      assertSafeSessionId(sessionId);
    } catch {
      return undefined;
    }
    const processLocal = this.processLocalBundle(sessionId);
    if (processLocal) {
      const state = processLocal.state;
      if (isSessionWorkspace(state.workspace)) return structuredClone(state.workspace);
      const mainRoot = sessionMainRoot(state);
      return mainRoot ? { root: mainRoot, kind: "main" } : undefined;
    }
    if (sessionId.startsWith("qchat-")) return undefined;
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

  /**
   * Commit a Session main-root migration as one state.json replacement.
   *
   * `cwd`, the durable project binding, and the execution workspace are one
   * consistency unit: exposing any subset would let a resumed run combine the
   * old authority with a new path. Derived availability such as dir_missing is
   * deliberately absent from this patch and is recomputed by the host.
   */
  migrateSessionMainRoot(
    sessionId: string,
    project: import("../types.js").SessionProjectBinding,
    mainRoot: string,
  ): number {
    if (
      !project ||
      typeof project.projectId !== "string" ||
      project.projectId.length === 0 ||
      typeof project.mainRootId !== "string" ||
      project.mainRootId.length === 0 ||
      typeof mainRoot !== "string" ||
      mainRoot.length === 0
    ) {
      throw new SessionError(`invalid main-root migration for ${sessionId}`);
    }
    return this.updateSessionState(sessionId, {
      project: { ...project },
      cwd: mainRoot,
      workspace: { root: mainRoot, kind: "main" },
    });
  }

  /**
   * Commit a host-owned offline migration only if the durable snapshot Main
   * just revalidated is still current. Unlike the ordinary field-level writer,
   * this must not retry onto a newer revision: a new writer means ownership is
   * no longer provably unchanged, so the migration fails closed.
   */
  migrateSessionMainRootIfRevision(
    sessionId: string,
    project: import("../types.js").SessionProjectBinding,
    mainRoot: string,
    expectedStateRevision: number | undefined,
  ): number {
    assertSafeSessionId(sessionId);
    if (
      !project ||
      typeof project.projectId !== "string" ||
      project.projectId.length === 0 ||
      typeof project.mainRootId !== "string" ||
      project.mainRootId.length === 0 ||
      typeof mainRoot !== "string" ||
      mainRoot.length === 0
    ) {
      throw new SessionError(`invalid main-root migration for ${sessionId}`);
    }
    const state = this.readPersistedState(sessionId);
    if (state.stateRevision !== expectedStateRevision) {
      throw new SessionError(`Session state revision conflict for ${sessionId}`);
    }
    Object.assign(state, {
      project: { ...project },
      cwd: mainRoot,
      workspace: { root: mainRoot, kind: "main" } as SessionWorkspace,
    });
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
    throw new SessionError(`Session state revision conflict for ${sessionId}`);
  }

  /** Read the durable archival timestamp; undefined = not archived / unprovable. */
  readSessionArchivedAt(sessionId: string): number | undefined {
    try {
      assertSafeSessionId(sessionId);
    } catch {
      return undefined;
    }
    const processLocal = this.processLocalBundle(sessionId);
    if (processLocal) return processLocal.state.archivedAt;
    if (sessionId.startsWith("qchat-")) return undefined;
    const stateFile = join(this.sessionsDir, sessionId, "state.json");
    if (!existsSync(stateFile)) return undefined;
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf-8")) as SessionState;
      return typeof state.archivedAt === "number" ? state.archivedAt : undefined;
    } catch {
      return undefined;
    }
  }

  /** Set (number) or clear (undefined) the durable archival marker. */
  setSessionArchived(sessionId: string, archivedAt: number | undefined): number {
    return this.updateSessionState(sessionId, { archivedAt });
  }

  recordWorkspaceHandoff(
    sessionId: string,
    from: SessionWorkspace | undefined,
    to: SessionWorkspace,
  ): void {
    assertSafeSessionId(sessionId);
    const processLocal = this.processLocalBundle(sessionId);
    if (processLocal) {
      processLocal.transcript.append("session_meta", {
        sessionId,
        cwd: to.root,
        workspace: to,
        handoffFrom: from?.root,
        handoffAt: Date.now(),
      });
      return;
    }
    if (sessionId.startsWith("qchat-")) return;
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
    let state: SessionState;
    try {
      state = this.readPersistedState(sessionId);
    } catch (err) {
      if (err instanceof SessionError) throw err;
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
  readActiveGoal(sessionId: string): import("../goal/lifecycle.js").GoalConfig | undefined {
    try {
      assertSafeSessionId(sessionId);
    } catch {
      return undefined;
    }
    const processLocal = this.processLocalBundle(sessionId);
    if (processLocal) {
      try {
        const state = hydrateGoalLifecycle(structuredClone(processLocal.state));
        const lifecycle = state.goalLifecycle;
        if (!lifecycle || lifecycle.phase === "terminal") return undefined;
        const goal = goalConfigFromLifecycle(lifecycle);
        return {
          ...goal,
          goalId: goal.goalId ?? deriveLegacyGoalId(sessionId, goal),
          revision: goal.revision ?? 1,
        };
      } catch {
        return undefined;
      }
    }
    if (sessionId.startsWith("qchat-")) return undefined;
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
      // Same identity: edits and pause/resume keep the goal's accumulated
      // progress (an open background wait is settled up to now).
      state.goalLifecycle = carryGoalProgress(
        createGoalLifecycle(goal, goal.paused === true ? "paused" : "active"),
        lifecycle,
      );
      hydrateGoalLifecycle(state);

      const result = this.saveStateAttempt(state);
      if (result.ok) return { goal, stateRevision: state.stateRevision!, state };
      if (result.reason !== "revision_conflict") return undefined;
    }
    return undefined;
  }

  resume(sessionId: string): SessionBundle {
    return this.resumeWithTranscriptMode(sessionId, false);
  }

  /**
   * Resume a model run with a bounded active replay for large Pet transcripts
   * that already contain a full-history archive boundary. Audit/detail callers
   * continue to use resume() and receive every persisted event.
   */
  resumeForRun(sessionId: string): SessionBundle {
    return this.resumeWithTranscriptMode(sessionId, true);
  }

  private resumeWithTranscriptMode(sessionId: string, contextOnly: boolean): SessionBundle {
    assertSafeSessionId(sessionId);
    const processLocal = this.processLocalBundle(sessionId);
    if (processLocal) {
      const state = hydrateGoalLifecycle(structuredClone(processLocal.state));
      state.kind = normalizedSessionKind(state.kind);
      state.status = "active";
      delete state.lastCompletionKind;
      Object.assign(state, normalizeCumulativeUsageCounters(state, state.tokenUsage));
      return { state, transcript: processLocal.transcript };
    }
    if (sessionId.startsWith("qchat-")) {
      throw new SessionError(`Session not found: ${sessionId}`);
    }
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
    if (process.platform !== "win32") {
      chmodSync(sessionDir, 0o700);
      chmodSync(stateFile, 0o600);
    }
    state.kind = normalizedSessionKind(state.kind);
    const transcript =
      contextOnly && state.kind === "pet"
        ? Transcript.loadContextFromFile(transcriptFile)
        : Transcript.loadFromFile(transcriptFile);

    state.status = "active";
    delete state.lastCompletionKind;
    Object.assign(state, normalizeCumulativeUsageCounters(state, state.tokenUsage));

    return { state, transcript };
  }

  /**
   * Return the exact persistence directory owned by this manager.
   *
   * Cross-session sidecars (for example versioned handoffs) use this to stay
   * inside an identity/custom-data-root boundary instead of falling back to
   * the process-global default sessions directory.
   */
  getStorageDir(): string {
    return this.sessionsDir;
  }

  /**
   * Read one durable session state without changing its lifecycle status.
   * `resume()` intentionally marks the returned in-memory state active; host
   * coordination code needs a read-only snapshot for completed cursors and
   * workspace/profile metadata.
   */
  readSessionState(sessionId: string): SessionState | undefined {
    try {
      assertSafeSessionId(sessionId);
      return structuredClone(this.readPersistedState(sessionId));
    } catch {
      return undefined;
    }
  }

  /** Whether a live or persisted Session is explicitly process-local. */
  isEphemeralSession(sessionId: string): boolean {
    return this.readSessionState(sessionId)?.ephemeral === true;
  }

  /**
   * Merge a field-level state update into the latest persisted snapshot.
   *
   * Unlike saveState(), callers do not supply a potentially stale whole-state
   * object. saveState serializes the read/revision-check/write section with the
   * per-session lock and returns the new persisted revision to the caller.
   */
  updateSessionState(
    sessionId: string,
    partial: SessionStateFieldPatch,
    expectedRunId?: string,
  ): number {
    return this.mergeSessionState(sessionId, () => partial, expectedRunId);
  }

  /** Compute an owned run's patch from the latest state on every CAS attempt. */
  updateSessionRunState(
    sessionId: string,
    expectedRunId: string,
    update: (current: Readonly<SessionState>) => SessionStateFieldPatch,
  ): number {
    return this.mergeSessionState(sessionId, update, expectedRunId);
  }

  private mergeSessionState(
    sessionId: string,
    update: (current: Readonly<SessionState>) => SessionStateFieldPatch | undefined,
    expectedRunId?: string,
  ): number {
    assertSafeSessionId(sessionId);
    for (let attempt = 0; attempt <= SESSION_STATE_LOCK_RETRY_DELAYS_MS.length; attempt++) {
      const state = this.readPersistedState(sessionId);
      // Re-check on every CAS retry: an older run must not merge its terminal
      // status into a newer run's identity after another writer wins the lock.
      if (expectedRunId !== undefined && state.runId !== expectedRunId) {
        throw new SessionError(`Session run identity conflict for ${sessionId}`);
      }
      const partial = update(structuredClone(state));
      // A conditional metadata update may stop after a CAS retry observes a
      // different owner. Do not write or advance that owner's revision.
      if (partial === undefined) return state.stateRevision ?? 0;
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

  /** Claim a run and return the identity replaced by the successful state CAS. */
  startSessionRun(
    state: SessionState,
    runId: string,
    clientMessageId?: string,
    actualModel?: { model: string; provider: string; modelConnectionId?: string },
  ): string | undefined {
    assertSafeSessionId(state.sessionId);
    for (let attempt = 0; attempt <= SESSION_STATE_LOCK_RETRY_DELAYS_MS.length; attempt++) {
      const latest = this.readPersistedState(state.sessionId);
      const previousRunId = latest.runId;
      const runFields = {
        ...actualModel,
        runId,
        clientMessageId,
        status: "active" as const,
        lastCompletionKind: undefined,
        turnSeq: (latest.turnSeq ?? 0) + 1,
      } satisfies SessionStateFieldPatch;
      Object.assign(latest, runFields);
      const result = this.saveStateAttempt(latest);
      if (result.ok) {
        Object.assign(state, runFields, { stateRevision: latest.stateRevision });
        return previousRunId;
      }
      if (result.reason !== "revision_conflict") {
        throw new SessionError(
          `Could not start session run for ${state.sessionId}: ${result.reason}`,
        );
      }
      // A competing opener won after our read. Its run is now the predecessor;
      // recompute both that identity and the turn sequence on the next attempt.
    }
    throw new SessionError(`Session state revision conflict for ${state.sessionId}`);
  }

  /**
   * Atomically add one billed auxiliary request to the latest source state.
   * This field-level read/add/write avoids publishing a detached stale state
   * snapshot and accounts every billed token and cost. Foreground cache metrics
   * remain unchanged; helper requests have a separate prompt/cache namespace.
   */
  recordAuxiliaryUsage(
    sessionId: string,
    usage: TokenUsage,
    costState?: Record<string, unknown> | (() => Record<string, unknown>),
  ): Pick<
    SessionState,
    | "tokenUsage"
    | "cacheUsageVersion"
    | "cumulativePromptTokens"
    | "cumulativeCacheReadTokens"
    | "cumulativeCacheCreationTokens"
    | "costState"
    | "stateRevision"
  > {
    assertSafeSessionId(sessionId);
    const capturedUsage = structuredClone(usage);
    for (let attempt = 0; attempt <= SESSION_STATE_LOCK_RETRY_DELAYS_MS.length; attempt++) {
      const state = this.readPersistedState(sessionId);
      Object.assign(state, normalizeCumulativeUsageCounters(state, state.tokenUsage));
      state.tokenUsage = addTokenUsage(state.tokenUsage, capturedUsage);
      if (costState !== undefined) {
        state.costState = typeof costState === "function" ? costState() : costState;
      }
      const result = this.saveStateAttempt(state);
      if (result.ok) {
        return {
          tokenUsage: state.tokenUsage,
          cacheUsageVersion: state.cacheUsageVersion,
          cumulativePromptTokens: state.cumulativePromptTokens,
          cumulativeCacheReadTokens: state.cumulativeCacheReadTokens,
          cumulativeCacheCreationTokens: state.cumulativeCacheCreationTokens,
          costState: state.costState,
          stateRevision: state.stateRevision,
        };
      }
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
        rebaseLiveState(state, latest);
        return "obsolete";
      }
      if (lifecycle.phase !== "terminal") {
        latest.goalLifecycle = terminateGoalLifecycle(lifecycle, lifecycleTerminalReason(reason));
        hydrateGoalLifecycle(latest);
      }
      const result = this.saveStateAttempt(latest);
      if (result.ok) {
        rebaseLiveState(state, latest);
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
   * Optional expected identity/revision fences are rechecked on every CAS retry,
   * so re-arming a waiting Goal cannot roll back a concurrent edit or pause.
   */
  saveActiveGoal(
    state: SessionState,
    goal: GoalConfig,
    options: {
      replaceCurrent?: boolean;
      expectedGoalId?: string;
      expectedRevision?: number;
    } = {},
  ): boolean {
    const armedGoal: GoalConfig = {
      ...goal,
      goalId: goal.goalId ?? deriveLegacyGoalId(state.sessionId, goal),
      revision: goal.revision ?? 1,
    };
    for (let attempt = 0; attempt <= SESSION_STATE_LOCK_RETRY_DELAYS_MS.length; attempt++) {
      const latest = this.readPersistedState(state.sessionId);
      const current = latest.goalLifecycle;
      if (
        (options.expectedGoalId !== undefined && current?.goalId !== options.expectedGoalId) ||
        (options.expectedRevision !== undefined && current?.revision !== options.expectedRevision)
      ) {
        rebaseLiveState(state, latest);
        return false;
      }
      if (current) {
        const sameIdentity = current.goalId === armedGoal.goalId;
        const sameRevision = current.revision === (armedGoal.revision ?? 1);
        if (current.phase === "terminal" && sameIdentity && sameRevision) return false;
        if (!options.replaceCurrent && sameIdentity && !sameRevision) {
          rebaseLiveState(state, latest);
          return false;
        }
        if (current.phase !== "terminal" && !options.replaceCurrent && !sameIdentity) return false;
      }
      if (
        current?.phase === "waiting" &&
        current.goalId === armedGoal.goalId &&
        current.revision === (armedGoal.revision ?? 1)
      ) {
        latest.goalLifecycle = armGoalLifecycle(current) ?? current;
      } else {
        latest.goalLifecycle = carryGoalProgress(
          createGoalLifecycle(armedGoal, armedGoal.paused === true ? "paused" : "active"),
          current?.phase === "terminal" ? undefined : current,
        );
      }
      hydrateGoalLifecycle(latest);
      const result = this.saveStateAttempt(latest);
      if (result.ok) {
        rebaseLiveState(state, latest);
        return true;
      }
      if (result.reason !== "revision_conflict") return false;
    }
    return false;
  }

  /** Persist active → waiting only for the expected concrete Goal version. */
  markGoalWaiting(
    state: SessionState,
    goal: GoalConfig,
    waitKind: GoalWaitKind = "background",
  ): boolean {
    const expectedGoalId = goal.goalId ?? deriveLegacyGoalId(state.sessionId, goal);
    const expectedRevision = Math.max(1, Math.floor(goal.revision ?? 1));
    for (let attempt = 0; attempt <= SESSION_STATE_LOCK_RETRY_DELAYS_MS.length; attempt++) {
      const latest = this.readPersistedState(state.sessionId);
      const lifecycle = latest.goalLifecycle;
      if (!lifecycle) return false;
      if (lifecycle.goalId !== expectedGoalId || lifecycle.revision !== expectedRevision) {
        rebaseLiveState(state, latest);
        return false;
      }
      if (lifecycle.phase === "waiting" && lifecycle.waitKind === waitKind) {
        rebaseLiveState(state, latest);
        return true;
      }
      // A wait of another kind is re-parked so its clock rule changes now
      // (an open background wait is settled first).
      const nowMs = Date.now();
      const active = lifecycle.phase === "waiting" ? armGoalLifecycle(lifecycle, nowMs) : lifecycle;
      const waiting = active ? waitGoalLifecycle(active, nowMs, waitKind) : undefined;
      if (!waiting) return false;
      latest.goalLifecycle = waiting;
      hydrateGoalLifecycle(latest);
      const result = this.saveStateAttempt(latest);
      if (result.ok) {
        rebaseLiveState(state, latest);
        return true;
      }
      if (result.reason !== "revision_conflict") return false;
    }
    return false;
  }

  /**
   * Add one run's goal accounting (judged rounds + running time) to the goal
   * that is still persisted under `goalId`. Revision is intentionally not
   * fenced: an edit or pause during the run keeps the same goal, and the
   * delta still belongs to it. A replaced goal (other id) drops the delta.
   * Does not bump the goal revision — this is accounting, not a control.
   */
  recordGoalProgress(
    state: SessionState,
    goalId: string,
    delta: { rounds?: number; activeMs?: number },
  ): boolean {
    if (!(delta.rounds ?? 0) && !(delta.activeMs ?? 0)) return true;
    for (let attempt = 0; attempt <= SESSION_STATE_LOCK_RETRY_DELAYS_MS.length; attempt++) {
      let latest: SessionState;
      try {
        latest = this.readPersistedState(state.sessionId);
      } catch {
        return false;
      }
      const lifecycle = latest.goalLifecycle;
      if (!lifecycle || lifecycle.goalId !== goalId) {
        rebaseLiveState(state, latest);
        return false;
      }
      latest.goalLifecycle = addGoalProgress(lifecycle, delta);
      hydrateGoalLifecycle(latest);
      const result = this.saveStateAttempt(latest);
      if (result.ok) {
        rebaseLiveState(state, latest);
        return true;
      }
      if (result.reason !== "revision_conflict") return false;
    }
    return false;
  }

  /**
   * Goal-level progress for the session's current (non-terminal) goal, for
   * clients restoring the Goal bar. Never throws; undefined when absent.
   */
  readGoalProgress(sessionId: string): (GoalProgressSnapshot & { goalId: string }) | undefined {
    try {
      assertSafeSessionId(sessionId);
      const lifecycle = this.readPersistedState(sessionId).goalLifecycle;
      if (!lifecycle || lifecycle.phase === "terminal") return undefined;
      const snapshot = goalProgressSnapshot(lifecycle);
      return snapshot && { goalId: lifecycle.goalId, ...snapshot };
    } catch {
      return undefined;
    }
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
        rebaseLiveState(state, latest);
        return true;
      }
      if (lifecycle.phase !== "terminal") return false;
      rebaseLiveState(state, latest);
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
  saveStateOrUpdateFields(
    state: SessionState,
    partial: SessionStateFieldPatch,
    expectedRunId?: string,
  ): boolean {
    try {
      const stateRevision = this.updateSessionState(state.sessionId, partial, expectedRunId);
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

    const processLocal = this.processLocalBundle(state.sessionId);
    if (processLocal) {
      const persisted = structuredClone(processLocal.state);
      const incomingKind = normalizedSessionKind(state.kind);
      const persistedKind = normalizedSessionKind(persisted.kind);
      if (incomingKind !== persistedKind) return { ok: false, reason: "kind_conflict" };
      state.kind = persistedKind;

      const persistedRevision = persisted.stateRevision;
      const incomingRevision = state.stateRevision;
      const revisionsMatch =
        (persistedRevision === undefined && incomingRevision === undefined) ||
        (typeof persistedRevision === "number" && incomingRevision === persistedRevision);
      if (!revisionsMatch) return { ok: false, reason: "revision_conflict" };

      if (persisted.title !== undefined && !("title" in state)) state.title = persisted.title;
      state.stateRevision = (persistedRevision ?? incomingRevision ?? 0) + 1;
      const next = hydrateGoalLifecycle(structuredClone(stateForPersistence(state)));
      rebaseLiveState(processLocal.state, next);
      if (state !== processLocal.state) rebaseLiveState(state, next);
      return { ok: true };
    }

    // A closed process-local session must stay gone even if a late writer
    // races the close fence.
    if (isEphemeralSessionState(state)) {
      return { ok: false, reason: "revision_conflict" };
    }

    const sessionDir = join(this.sessionsDir, state.sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const target = join(sessionDir, "state.json");
    // proper-lockfile uses an atomic mkdir lock plus an mtime lease. It
    // recovers crash-orphaned locks after `stale` and refreshes live locks so a
    // slow writer is not stolen. Short genuine contention gets bounded retry.
    const release = acquireStateLock(target);
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
      preservePersistedRecoveryFields(state, persisted);

      state.stateRevision = (persistedRevision ?? incomingRevision ?? 0) + 1;
      this.writeStateAtomically(target, stateForPersistence(state));
      return { ok: true };
    } finally {
      try {
        release();
      } catch {
        // A compromised/reaped lease must not mask the persistence result.
      }
    }
  }

  /** Kept as an instance seam so tests can inject a state.json write failure. */
  private writeStateAtomically(target: string, state: SessionState, label = "state"): void {
    writeStateFileAtomically(target, state, label);
  }

  private readPersistedState(sessionId: string): SessionState {
    const processLocal = this.processLocalBundle(sessionId);
    if (processLocal) return hydrateGoalLifecycle(structuredClone(processLocal.state));
    if (sessionId.startsWith("qchat-")) {
      throw new SessionError(`Session state file not found: ${sessionId}`);
    }
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
    const processLocal = this.processLocalBundle(sourceSessionId);
    if (processLocal) {
      return Transcript.selectContextRange(processLocal.transcript.getEvents(), range);
    }
    if (sourceSessionId.startsWith("qchat-")) {
      throw new SessionError(`Session not found: ${sourceSessionId}`);
    }
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
    const summaryEvent = buildSummaryTransferEvent(sourceSessionId, options, createdAt);
    const bundle = this.publishSessionAtomically(targetSessionId, state, [meta!, summaryEvent]);
    return { bundle, lineage, copiedEventCount: 0 };
  }

  private readForkSnapshot(
    sourceSessionId: string,
    throughEventId: string | undefined,
    snapshotMode: "tail" | "completed",
  ): FrozenForkSnapshot {
    const processLocal = this.processLocalBundle(sourceSessionId);
    if (processLocal) {
      return freezeForkSnapshot(
        sourceSessionId,
        structuredClone(processLocal.state),
        processLocal.transcript.getEvents(),
        throughEventId,
        snapshotMode,
      );
    }
    if (sourceSessionId.startsWith("qchat-")) {
      throw new SessionError(`Session not found: ${sourceSessionId}`);
    }
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
    return freezeForkSnapshot(
      sourceSessionId,
      sourceState,
      parsed.events,
      throughEventId,
      snapshotMode,
    );
  }

  private publishSessionAtomically(
    targetSessionId: string,
    state: SessionState,
    events: readonly TranscriptEvent[],
  ): SessionBundle {
    const targetDir = join(this.sessionsDir, targetSessionId);
    if (isEphemeralSessionState(state)) {
      if (this.processLocalBundle(targetSessionId) || existsSync(targetDir)) {
        throw new SessionError(`Session already exists: ${targetSessionId}`);
      }
      const bundle = {
        state: hydrateGoalLifecycle(structuredClone(state)),
        transcript: Transcript.fromMemoryEvents(targetSessionId, events),
      };
      this.storeProcessLocalBundle(bundle);
      return bundle;
    }
    if (existsSync(targetDir)) throw new SessionError(`Session already exists: ${targetSessionId}`);
    const stagingDir = join(this.sessionsDir, `.pending-fork-${targetSessionId}-${nanoid(8)}`);
    let published = false;
    try {
      mkdirSync(stagingDir, { mode: 0o700 });
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

  list(
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
  ): SessionListEntry[] {
    return listSessionEntries(this.sessionsDir, limit, opts);
  }
}

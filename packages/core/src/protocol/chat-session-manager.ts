import { join } from "node:path";
import { ChatSession } from "./chat-session.js";
import { codeShellHome } from "../session/session-manager.js";
import type { SessionKind } from "../types.js";
import type { Engine } from "../engine/engine.js";
import type { EngineRuntime } from "../engine/runtime.js";
import type { EngineConfig } from "../engine/types.js";
import { backgroundShellManager } from "../runtime/background-shell.js";
import { clearAgentOutputFiles } from "../tool-system/builtin/agent-output-file.js";
import { backgroundJobRegistry } from "../tool-system/builtin/background-jobs.js";
import { clearCredentialSessionAllow } from "../credentials/use-credential-tool.js";
import { clearInjectCredentialSessionAllow } from "../credentials/inject-credential-tool.js";
import { logger } from "../logging/logger.js";
import { clearSessionPathApprovals, openSessionPathApprovals } from "../tool-system/path-policy.js";
import {
  clearInteractiveApprovalSession,
  openInteractiveApprovalSession,
} from "../tool-system/permission.js";

export type EngineConfigSlice = Pick<
  EngineConfig,
  | "permissionMode"
  | "preset"
  | "customSystemPrompt"
  | "appendSystemPrompt"
  | "goal"
  | "maxTurns"
  | "maxContextTokens"
  | "cwd"
  | "projectTrusted"
  // Identity-scoped session persistence root. Only identity-derived managers
  // (see ChatSessionManager.forIdentity) set it; the default path leaves it
  // undefined, so existing engineFactory implementations are unaffected.
  | "sessionStorageDir"
>;

/** Identity scope every ChatSessionManager belongs to when none is injected. */
export const LOCAL_CHAT_IDENTITY = "local";

/**
 * An identity becomes an on-disk path segment (`<root>/identities/<id>`), so
 * it gets the same conservative validation as session ids: no separators, no
 * parent-dir tokens, short, and a strict character allow-list.
 */
function assertSafeIdentity(identity: string): void {
  if (typeof identity !== "string" || identity.length === 0 || identity.length > 64) {
    throw new Error(`invalid identity: must be a non-empty string of at most 64 chars`);
  }
  if (
    identity.includes("/") ||
    identity.includes("\\") ||
    identity === "." ||
    identity.includes("..") ||
    !/^[A-Za-z0-9_.-]+$/.test(identity)
  ) {
    throw new Error(`invalid identity: unexpected characters: ${identity}`);
  }
}

export interface ChatSessionManagerOptions {
  /**
   * Shared runtime, supplied here so callers and engineFactory closures
   * derived from these options can reference one canonical instance. The
   * manager itself does not retain it — engineFactory captures it via closure.
   */
  runtime: EngineRuntime;
  /** Build an Engine. Tests inject a fake; production passes a runtime-backed Engine factory. */
  engineFactory: (slice: EngineConfigSlice) => Engine;
  maxSessions?: number; // default 16
  idleTtlMs?: number; // default 30 min
  /** Host lifecycle generation attached to Pet projection snapshots/deltas. */
  projectionGeneration?: number;
  /**
   * Identity scope this manager serves. Defaults to "local" — the single
   * OS-user manager every host uses today. A server host that authenticates
   * connections derives one manager per identity via {@link
   * ChatSessionManager.forIdentity}; sessions never cross identities.
   */
  identity?: string;
  /**
   * Base data root used to derive per-identity session persistence
   * (`<dataRoot>/identities/<id>/sessions`). Defaults to `codeShellHome()`
   * (`CODE_SHELL_HOME` env → `~/.code-shell`). Only consulted when a
   * non-default identity manager is derived — the default "local" manager
   * never redirects persistence.
   */
  dataRoot?: string;
}

export interface LiveChatSessionSnapshot {
  generation: number;
  /** Identity scope of the manager that produced this snapshot. */
  identity: string;
  sessions: Array<{
    sessionId: string;
    busy: boolean;
    queueDepth: number;
    lastActivityAt: number;
    kind: SessionKind;
  }>;
}

export const CLOSED_CHAT_SESSION_TOMBSTONE_LIMIT = 4096;

export class ChatSessionManager {
  private readonly sessions = new Map<string, ChatSession>();
  private readonly closingSessions = new Map<string, Promise<void>>();
  private readonly closedSessions = new Set<string>();
  private readonly sessionGeneration = new Map<string, number>();
  readonly runtime: EngineRuntime;
  /** Identity scope this manager serves ("local" unless injected). */
  readonly identity: string;
  private readonly factory: (slice: EngineConfigSlice) => Engine;
  private readonly maxSessions: number;
  private readonly idleTtlMs: number;
  private readonly projectionGeneration: number;
  /** Construction options retained so forIdentity() can derive siblings. */
  private readonly baseOptions: ChatSessionManagerOptions;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ChatSessionManagerOptions) {
    this.runtime = opts.runtime;
    this.identity = opts.identity ?? LOCAL_CHAT_IDENTITY;
    if (opts.identity !== undefined) assertSafeIdentity(opts.identity);
    this.factory = opts.engineFactory;
    this.maxSessions = opts.maxSessions ?? 16;
    this.idleTtlMs = opts.idleTtlMs ?? 30 * 60 * 1000;
    this.projectionGeneration = opts.projectionGeneration ?? 1;
    this.baseOptions = opts;
  }

  /**
   * Derive a manager scoped to another identity. The derived manager shares
   * this manager's runtime/limits but persists its sessions under
   * `<dataRoot>/identities/<identity>/sessions` by injecting
   * `sessionStorageDir` into every engineFactory slice (Task 1's SessionManager
   * storageDir seam). Asking for this manager's own identity returns `this`
   * unchanged, so the default single-identity ("local") path is byte-for-byte
   * today's behavior. Callers (AgentServer) cache derived managers per
   * identity; each call here builds a fresh instance.
   */
  forIdentity(identity: string): ChatSessionManager {
    assertSafeIdentity(identity);
    if (identity === this.identity) return this;
    const sessionStorageDir = join(
      this.baseOptions.dataRoot ?? codeShellHome(),
      "identities",
      identity,
      "sessions",
    );
    const baseFactory = this.baseOptions.engineFactory;
    return new ChatSessionManager({
      ...this.baseOptions,
      identity,
      engineFactory: (slice) => baseFactory({ ...slice, sessionStorageDir }),
    });
  }

  async getOrCreate(sessionId: string, slice: EngineConfigSlice): Promise<ChatSession> {
    const closing = this.closingSessions.get(sessionId);
    if (closing) {
      await closing;
    }
    return this.getOrCreateNow(sessionId, slice);
  }

  /**
   * Cold-resume a persisted session using its own cwd. The first detached
   * Engine is only a storage probe; all actual work runs on the second Engine
   * built from the recovered project slice.
   */
  async getOrCreatePersisted(
    sessionId: string,
    slice: Partial<EngineConfigSlice> = {},
    restorePersistedModel = true,
  ): Promise<ChatSession | null> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const probe = this.factory(slice as EngineConfigSlice);
    if (!probe.sessionExistsOnDisk(sessionId)) return null;
    const cwd = probe.getSessionManager().readSessionMainRoot(sessionId);
    if (!cwd) return null;
    const session = await this.getOrCreate(sessionId, {
      ...slice,
      cwd,
      projectTrusted: slice.projectTrusted ?? false,
    } as EngineConfigSlice);
    if (restorePersistedModel) session.engine.restoreSessionModel(sessionId);
    return session;
  }

  private getOrCreateNow(sessionId: string, slice: EngineConfigSlice): ChatSession {
    openSessionPathApprovals(sessionId);
    openInteractiveApprovalSession(sessionId);
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastActivityAt = Date.now();
      if (slice.permissionMode && existing.engine.getPermissionMode?.() !== slice.permissionMode) {
        existing.engine.setPermissionMode?.(slice.permissionMode);
      }
      return existing;
    }
    if (this.sessions.size >= this.maxSessions) {
      const err = new Error(`Overloaded: maxSessions=${this.maxSessions} reached`);
      (err as any).code = -32001;
      throw err;
    }
    const engine = this.factory(slice);
    const session = new ChatSession({ id: sessionId, engine });
    const sessionManager = this.engineSessionManager(engine);
    const generation = sessionManager?.registerSessionGeneration(sessionId) ?? 1;
    this.sessionGeneration.set(sessionId, generation);
    this.sessions.set(sessionId, session);
    // A direct user run is an explicit resume/open and may clear the tombstone.
    // Background wakeups must check isUnavailable() before reaching this path.
    this.closedSessions.delete(sessionId);
    return session;
  }

  get(sessionId: string): ChatSession | undefined {
    return this.sessions.get(sessionId);
  }

  isClosing(sessionId: string): boolean {
    return this.closingSessions.has(sessionId);
  }

  isClosed(sessionId: string): boolean {
    return this.closedSessions.has(sessionId);
  }

  isUnavailable(sessionId: string): boolean {
    return this.isClosing(sessionId) || this.isClosed(sessionId);
  }

  sessionExistsOnDisk(sessionId: string, slice: EngineConfigSlice): boolean {
    const existing = this.sessions.get(sessionId);
    if (existing) return true;
    const probeEngine = this.factory(slice);
    return probeEngine.sessionExistsOnDisk(sessionId);
  }

  /**
   * Iterate every live session once. Public iterator so callers (e.g. the
   * protocol server's config hot-reload / sessions query) don't reach into
   * the private `sessions` map with an `as any` cast. Iterates a snapshot of
   * the values so a callback that closes a session can't perturb the walk.
   */
  forEachSession(fn: (s: ChatSession) => void): void {
    for (const s of [...this.sessions.values()]) fn(s);
  }

  /** Snapshot-safe, read-only source shared by query("sessions") and Pet projection. */
  getLiveSessionSnapshot(): LiveChatSessionSnapshot {
    const sessions: LiveChatSessionSnapshot["sessions"] = [];
    this.forEachSession((session) => {
      sessions.push({
        sessionId: session.id,
        busy: session.isBusy(),
        queueDepth: session.queueDepth(),
        lastActivityAt: session.lastActivityAt,
        kind:
          (
            session.engine as Engine & {
              getSessionManager?: () => { readSessionKind?: (sessionId: string) => SessionKind };
            }
          )
            .getSessionManager?.()
            .readSessionKind?.(session.id) ?? "work",
      });
    });
    sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    return { generation: this.projectionGeneration, identity: this.identity, sessions };
  }

  close(sessionId: string): Promise<void> {
    return this.closeSession(sessionId, true);
  }

  private closeSession(sessionId: string, markClosed: boolean): Promise<void> {
    const alreadyClosing = this.closingSessions.get(sessionId);
    if (alreadyClosing) return alreadyClosing;
    const s = this.sessions.get(sessionId);
    if (!s) {
      if (markClosed) this.rememberClosedSession(sessionId);
      return Promise.resolve();
    }

    const sessionManager = this.engineSessionManager(s.engine);
    const generation = this.sessionGeneration.get(sessionId) ?? 0;
    const invalidated = sessionManager?.incrementSessionGeneration(sessionId) ?? generation + 1;
    this.sessionGeneration.set(sessionId, invalidated);
    s.cancel();
    clearSessionPathApprovals(sessionId);
    clearInteractiveApprovalSession(sessionId);
    clearCredentialSessionAllow(sessionId);
    clearInjectCredentialSessionAllow(sessionId);
    const finishClose = () => {
      this.unregisterMcpOwner(s);
      if (this.sessions.get(sessionId) === s) this.sessions.delete(sessionId);
      if (markClosed) this.rememberClosedSession(sessionId);
      else this.closedSessions.delete(sessionId);
      this.sessionGeneration.delete(sessionId);
    };
    if (!s.isBusy()) {
      finishClose();
      return Promise.resolve();
    }
    const closing = (async () => {
      try {
        await s.settled;
        finishClose();
      } finally {
        this.closingSessions.delete(sessionId);
      }
    })();
    this.closingSessions.set(sessionId, closing);
    return closing;
  }

  private rememberClosedSession(sessionId: string): void {
    this.closedSessions.delete(sessionId);
    this.closedSessions.add(sessionId);
    while (this.closedSessions.size > CLOSED_CHAT_SESSION_TOMBSTONE_LIMIT) {
      const oldest = this.closedSessions.values().next().value;
      if (oldest === undefined) break;
      this.closedSessions.delete(oldest);
    }
  }

  closeAll(): void {
    // Fire-and-forget variant for callers that can't await (e.g. AgentServer
    // teardown inside a sync stop path). The TUI exit path uses closeAllAsync()
    // below so the SIGTERM→SIGKILL grace actually completes before the process
    // exits — otherwise startInkRepl's process.exit(0) races the kill and the
    // detached shells leak as orphans.
    void this.closeAllAsync();
  }

  /**
   * Await-able shutdown. Cancels every session and reaps every background
   * shell, *waiting* for the kill grace so a caller that exits the process
   * immediately afterward (the TUI REPL) doesn't orphan detached dev servers.
   */
  async closeAllAsync(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
    // App/worker shutdown — reap every background shell so a detached
    // `npm run dev` doesn't outlive the process as an orphan holding a port
    // (design §6 / §难点1). NOTE: deliberately NOT in close()/sweepIdle() —
    // an idle chat tab must keep its dev server alive (§6 "切走再回来 server 还在").
    await backgroundShellManager.killAll();
    // Background-agent output files are a debugging convenience, not durable
    // state — wipe them on shutdown so ~/.code-shell/agents doesn't grow
    // unbounded across runs. (notificationQueue, the real result path, is
    // in-memory and already gone.)
    await clearAgentOutputFiles();
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  sweepIdle(): void {
    const cutoff = Date.now() - this.idleTtlMs;
    for (const [id, s] of [...this.sessions]) {
      if (s.lastActivityAt >= cutoff) continue;
      if (s.isBusy()) continue;
      if (backgroundJobRegistry.hasRunningForSession(id)) continue;
      void this.closeSession(id, false);
    }
  }

  startIdleSweeper(intervalMs = 60_000): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweepIdle(), intervalMs);
    // Allow the process to exit even if sweeper is pending.
    (this.sweeper as any)?.unref?.();
  }

  stopIdleSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  private unregisterMcpOwner(session: ChatSession): void {
    const mcpPool = (
      this.runtime as {
        mcpPool?: { unregisterOwner?: (owner: unknown) => Promise<void> };
      }
    ).mcpPool;
    if (typeof mcpPool?.unregisterOwner !== "function") return;
    void mcpPool.unregisterOwner(session.engine).catch((err) => {
      logger.warn("chat_session.mcp_owner_unregister_failed", {
        sessionId: session.id,
        identity: this.identity,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private engineSessionManager(engine: Engine):
    | {
        registerSessionGeneration: (sessionId: string) => number;
        incrementSessionGeneration: (sessionId: string) => number;
      }
    | undefined {
    const candidate = engine as Engine & {
      getSessionManager?: () => {
        registerSessionGeneration?: (sessionId: string) => number;
        incrementSessionGeneration?: (sessionId: string) => number;
      };
    };
    const manager = candidate.getSessionManager?.();
    if (
      typeof manager?.registerSessionGeneration !== "function" ||
      typeof manager.incrementSessionGeneration !== "function"
    ) {
      return undefined;
    }
    return manager as {
      registerSessionGeneration: (sessionId: string) => number;
      incrementSessionGeneration: (sessionId: string) => number;
    };
  }
}

/**
 * Factory counterpart of `new ChatSessionManager(opts)` for identity/dataRoot
 * aware hosts (identity dimension foundations, Task 2). Identity defaults to
 * "local" and dataRoot to `codeShellHome()`, so omitting both is exactly the
 * constructor every existing host already calls.
 */
export function createChatSessionManager(opts: ChatSessionManagerOptions): ChatSessionManager {
  return new ChatSessionManager(opts);
}

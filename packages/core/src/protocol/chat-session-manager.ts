import { ChatSession } from "./chat-session.js";
import type { Engine } from "../engine/engine.js";
import type { EngineRuntime } from "../engine/runtime.js";
import type { EngineConfig } from "../engine/types.js";
import { backgroundShellManager } from "../runtime/background-shell.js";
import { clearAgentOutputFiles } from "../tool-system/builtin/agent-output-file.js";
import { clearCredentialSessionAllow } from "../credentials/use-credential-tool.js";
import { clearInjectCredentialSessionAllow } from "../credentials/inject-credential-tool.js";
import { logger } from "../logging/logger.js";
import { clearSessionPathApprovals, openSessionPathApprovals } from "../tool-system/path-policy.js";

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
>;

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
}

export class ChatSessionManager {
  private readonly sessions = new Map<string, ChatSession>();
  readonly runtime: EngineRuntime;
  private readonly factory: (slice: EngineConfigSlice) => Engine;
  private readonly maxSessions: number;
  private readonly idleTtlMs: number;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ChatSessionManagerOptions) {
    this.runtime = opts.runtime;
    this.factory = opts.engineFactory;
    this.maxSessions = opts.maxSessions ?? 16;
    this.idleTtlMs = opts.idleTtlMs ?? 30 * 60 * 1000;
  }

  getOrCreate(sessionId: string, slice: EngineConfigSlice): ChatSession {
    openSessionPathApprovals(sessionId);
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastActivityAt = Date.now();
      // Re-apply the per-send permission mode so a pill change on an
      // already-running session takes effect on the NEXT turn. Without this the
      // engine kept whatever mode it was first created with — changing the pill
      // on a resumed session was silently ignored at enforcement time (#11
      // secondary: "档位 doesn't take effect after first send"). setPermissionMode
      // reconfigures the live permission backend, so it's safe between turns.
      if (
        slice.permissionMode &&
        typeof existing.engine.getPermissionMode === "function" &&
        existing.engine.getPermissionMode() !== slice.permissionMode
      ) {
        existing.engine.setPermissionMode(slice.permissionMode);
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
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): ChatSession | undefined {
    return this.sessions.get(sessionId);
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

  close(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.cancel();
    clearSessionPathApprovals(sessionId);
    clearCredentialSessionAllow(sessionId);
    clearInjectCredentialSessionAllow(sessionId);
    this.unregisterMcpOwner(s);
    this.sessions.delete(sessionId);
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
    for (const id of [...this.sessions.keys()]) this.close(id);
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
      if (s.lastActivityAt < cutoff && !s.isBusy()) this.close(id);
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
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

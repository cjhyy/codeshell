import { ChatSession } from "./chat-session.js";
import type { Engine } from "../engine/engine.js";
import type { EngineRuntime } from "../engine/runtime.js";
import type { EngineConfig } from "../engine/engine.js";

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
  maxSessions?: number;   // default 16
  idleTtlMs?: number;     // default 30 min
}

export class ChatSessionManager {
  private readonly sessions = new Map<string, ChatSession>();
  private readonly factory: (slice: EngineConfigSlice) => Engine;
  private readonly maxSessions: number;
  private readonly idleTtlMs: number;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ChatSessionManagerOptions) {
    this.factory = opts.engineFactory;
    this.maxSessions = opts.maxSessions ?? 16;
    this.idleTtlMs = opts.idleTtlMs ?? 30 * 60 * 1000;
  }

  getOrCreate(sessionId: string, slice: EngineConfigSlice): ChatSession {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastActivityAt = Date.now();
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
    this.sessions.delete(sessionId);
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
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
}

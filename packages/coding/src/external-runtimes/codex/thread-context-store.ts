/**
 * Maps a Codex thread to the CodeShell session tool host that serves it.
 *
 * One loopback MCP bridge serves every concurrent Codex thread, so this map is
 * what keeps two sessions apart. Identity arrives as `_meta.threadId`, injected
 * by the Codex app-server and — verified empirically against codex-cli 0.145.0,
 * see `docs/todo/evidence/` — not influenceable by the model. Tool *arguments*
 * are the opposite: fully model-controlled, and therefore never consulted here.
 *
 * Every failure mode is a refusal. There is no "use the foreground session",
 * no "most recent thread", and no "there's only one, so it must be that one" —
 * §11.3 and §22.5 reject all of those, because each turns a background run into
 * a cross-session action.
 *
 * Memory-only by design (§13.6): hosts hold live executors and approval routes,
 * so the map is rebuilt after a restart rather than persisted.
 */

/** Anything the bridge can dispatch a tool call to. Structural on purpose so
 *  this file stays free of a hard dependency on the host implementation. */
export interface CodexToolHostRef {
  readonly businessSessionId: string;
}

export type ThreadContextMissReason =
  | "missing_thread_id"
  | "unknown_thread"
  | "stale_generation"
  | "ambiguous_thread";

export type ThreadContextResult<T> =
  | { ok: true; host: T }
  | { ok: false; reason: ThreadContextMissReason };

export interface ResolveRequest {
  /** From `_meta.threadId` (or `_meta["x-codex-turn-metadata"].thread_id`). */
  threadId: string | undefined;
  /** App-server generation the request belongs to; see {@link bumpGeneration}. */
  generation: number;
}

interface Entry<T> {
  host: T;
  generation: number;
}

export class CodexThreadContextStore<T extends CodexToolHostRef = CodexToolHostRef> {
  /** Non-enumerable so a stray `JSON.stringify(store)` cannot leak live hosts. */
  private readonly byThread = new Map<string, Entry<T>>();
  private currentGeneration = 1;

  get size(): number {
    return this.byThread.size;
  }

  get generation(): number {
    return this.currentGeneration;
  }

  /**
   * Bind a thread to its host. Re-registering the same thread replaces the
   * binding — a resumed thread points at the new host, and nothing accumulates.
   */
  register(threadId: string, host: T, generation: number): void {
    this.byThread.set(threadId, { host, generation });
    if (generation > this.currentGeneration) this.currentGeneration = generation;
  }

  /** Drop a thread. Call this BEFORE closing the host, so a late request finds
   *  nothing rather than a disposed host (§13.4 ordering). */
  unregister(threadId: string): void {
    this.byThread.delete(threadId);
  }

  clear(): void {
    this.byThread.clear();
  }

  /**
   * Advance the generation, e.g. after an app-server restart. Requests stamped
   * with an older generation are refused even if their thread id was re-used,
   * which is what stops a late reply from the dead process landing on the new
   * session (§13.6).
   */
  bumpGeneration(): number {
    this.currentGeneration += 1;
    return this.currentGeneration;
  }

  resolve(request: ResolveRequest): ThreadContextResult<T> {
    if (!request.threadId) return { ok: false, reason: "missing_thread_id" };
    const entry = this.byThread.get(request.threadId);
    if (!entry) return { ok: false, reason: "unknown_thread" };
    if (entry.generation !== request.generation) {
      return { ok: false, reason: "stale_generation" };
    }
    return { ok: true, host: entry.host };
  }

  /**
   * Resolve a batch that must belong to exactly one thread.
   *
   * Resolving each item separately would let a mixed batch touch two sessions
   * on the strength of a single authorization, so a batch spanning threads is
   * refused as a whole. An empty batch is refused too: there is no thread to
   * attribute it to, and "nothing to do" is not a reason to hand back a host.
   */
  resolveBatch(
    threadIds: readonly (string | undefined)[],
    generation: number,
  ): ThreadContextResult<T> {
    if (threadIds.length === 0) return { ok: false, reason: "missing_thread_id" };
    if (threadIds.some((id) => !id)) return { ok: false, reason: "missing_thread_id" };
    const unique = new Set(threadIds as readonly string[]);
    if (unique.size > 1) return { ok: false, reason: "ambiguous_thread" };
    return this.resolve({ threadId: [...unique][0], generation });
  }

  /** Threads currently bound, for diagnostics. Ids only — never hosts. */
  threadIds(): readonly string[] {
    return [...this.byThread.keys()];
  }

  /** Keep live hosts out of any accidental serialization (§12.4 logging rules). */
  toJSON(): { generation: number; threadCount: number } {
    return { generation: this.currentGeneration, threadCount: this.byThread.size };
  }
}

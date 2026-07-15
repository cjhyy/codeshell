// packages/desktop/src/main/worker-bridge-core.ts
//
// WorkerBridgeCore — transport-agnostic driver for a per-user agent worker
// subprocess speaking line-delimited JSON-RPC over stdio.
//
// This is the Electron-free half of the old AgentBridge, split out so other
// hosts (e.g. packages/server driving per-user stdio workers) can reuse it.
// It owns:
//   - child process spawn / respawn (one worker at a time, spawned on demand)
//   - stdout line framing (readline split) + listener dispatch
//   - request/response correlation (id → resolver, with timeout / consume /
//     settle-on-exit semantics)
//   - inbound line injection (`injectWorkerMessage`) with a pluggable
//     `prepareInbound` hook for host-specific rewriting (e.g. agent/run trust)
//   - worker generation counter (bumped on every successful spawn)
//   - pending outbox flushed once the worker's stdin exists
//   - crash accounting (N crashes per rolling window ⇒ "gave up")
//   - graceful shutdown (SIGTERM)
//
// It must have ZERO electron imports. All host semantics (renderer fan-out,
// pet projection, browser/credential intercepts, …) live in the caller via
// the constructor callbacks and `subscribeLines`.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

const DEFAULT_RESTART_WINDOW_MS = 60_000;
const DEFAULT_RESTART_LIMIT = 3;

/** Truncate a wire line for logs. */
export function previewLine(s: string, max = 200): string {
  return s.length > max ? s.slice(0, max) + `…(+${s.length - max} more)` : s;
}

export type WorkerBridgeLog = (event: string, data?: Record<string, unknown>) => void;

export interface WorkerExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** true only for code === 0 && signal === null (normal completion). */
  clean: boolean;
  /** true when a crash pushed past the restart limit inside the window. */
  gaveUp: boolean;
}

/** Outcome of a correlated JSON-RPC request. Never rejects — callers map. */
export type WorkerRpcOutcome =
  | { status: "result"; result: unknown }
  | { status: "error"; error: { message?: string; code?: number } }
  | { status: "timeout" }
  /** Sending the frame failed (no live worker, or the write threw). */
  | { status: "sendFailed"; error?: unknown }
  /** Worker exited while pending (only for `settleOnExit: true` requests). */
  | { status: "workerExit" };

export interface WorkerRequestOptions {
  /** Wire id for the frame. Caller mints it (must be unique while pending). */
  id: string;
  timeoutMs: number;
  /**
   * true: the matching response line is consumed here and NOT dispatched to
   * line listeners (host-internal RPC, e.g. pet snapshots). false: the line
   * is settled AND still dispatched, so downstream mirrors see it unchanged.
   */
  consume?: boolean;
  /** Settle with { status: "workerExit" } when the worker dies while pending. */
  settleOnExit?: boolean;
  /** Settle with { status: "sendFailed" } immediately when the frame can't be
   *  written; otherwise a failed send leaves the request pending until the
   *  timeout (matches fire-and-forget inject semantics). */
  failFast?: boolean;
  /** Spawn the worker on demand (idempotent) before writing the frame. Set for
   *  requests that are meant to WAKE the worker — e.g. a pet/IM-gateway
   *  `agent/run` — mirroring the renderer's spawn-on-`agent/run` path. Without
   *  it a request to a lazily-unspawned worker is dropped and hangs to timeout.
   *  Optionally pass the cwd the fresh worker should use. */
  ensureWorker?: boolean;
  /** cwd handed to ensureWorker() when it spawns. Ignored unless ensureWorker. */
  ensureWorkerCwd?: string;
}

export interface WorkerBridgeCoreOptions {
  /** Absolute path of the worker entry script (agent-server-stdio). */
  entryPath: string;
  /** Runtime binary; defaults to process.execPath. */
  execPath?: string;
  /** Build the spawn env (called per spawn). Defaults to process.env. */
  buildEnv?: () => NodeJS.ProcessEnv;
  /** cwd used when ensureWorker() is called without one. */
  fallbackCwd?: () => string;
  log?: WorkerBridgeLog;
  /**
   * Rewrite/side-effect hook for injectWorkerMessage lines (e.g. agent/run
   * trust metadata + on-demand spawn). Returns the line to write; `method`
   * is only used for log context.
   */
  prepareInbound?: (line: string) => { line: string; method?: string };
  /** A worker successfully spawned with piped stdio. */
  onWorkerStarted?: (info: { generation: number; pid?: number }) => void;
  /** spawn() threw synchronously, or stdio came back unpiped. No child. */
  onSpawnFailed?: () => void;
  /** The child emitted 'error' (ENOENT/EACCES/…) — no 'exit' will follow. */
  onSpawnError?: (error: unknown) => void;
  onExit?: (info: WorkerExitInfo) => void;
  onStderr?: (text: string) => void;
  restartWindowMs?: number;
  restartLimit?: number;
}

interface PendingRequest {
  consume: boolean;
  settleOnExit: boolean;
  settle: (outcome: WorkerRpcOutcome) => void;
}

export class WorkerBridgeCore {
  private child: ChildProcess | null = null;
  /** Pending lines that arrived before the worker's stdin existed. */
  private outbox: string[] = [];
  private restartCount = 0;
  private restartWindowStart = Date.now();
  private generation = 0;
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly pendingRequests = new Map<string | number, PendingRequest>();
  private readonly restartWindowMs: number;
  private readonly restartLimit: number;

  constructor(private readonly opts: WorkerBridgeCoreOptions) {
    this.restartWindowMs = opts.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS;
    this.restartLimit = opts.restartLimit ?? DEFAULT_RESTART_LIMIT;
  }

  private log(event: string, data?: Record<string, unknown>): void {
    this.opts.log?.(event, data);
  }

  /** Current worker generation (0 until the first successful spawn). */
  workerGeneration(): number {
    return this.generation;
  }

  hasChild(): boolean {
    return this.child !== null;
  }

  /** stdin exists and is not destroyed — a line write won't be dropped. */
  canSend(): boolean {
    return !!this.child?.stdin && !this.child.stdin.destroyed;
  }

  hasLiveWorker(): boolean {
    return !!this.child?.stdin?.writable && !this.child.stdin.destroyed;
  }

  /**
   * Spawn the worker if none is alive. `cwd` is the working directory the
   * Engine will use (i.e. the repo root). Idempotent if a child is alive.
   */
  ensureWorker(requestedCwd?: string): void {
    if (this.child) return;
    const workerCwd = requestedCwd ?? this.opts.fallbackCwd?.() ?? process.cwd();
    this.log("spawn.start", {
      cwd: workerCwd,
      requestedCwd,
      restartCount: this.restartCount,
    });
    let child: ChildProcess;
    try {
      child = spawn(this.opts.execPath ?? process.execPath, [this.opts.entryPath], {
        cwd: workerCwd,
        env: this.opts.buildEnv ? this.opts.buildEnv() : process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      // spawn() can throw synchronously (e.g. invalid execPath). Don't let it
      // bubble out of the caller uncaught — declare give-up so the host
      // rejects the pending run instead of hanging.
      this.log("spawn.throw", { error: String(e) });
      this.child = null;
      this.opts.onSpawnFailed?.();
      return;
    }
    this.child = child;
    this.log("spawn.ok", { pid: child.pid, cwd: workerCwd, requestedCwd });
    if (!child.stdout || !child.stdin || !child.stderr) {
      this.log("spawn.error", { reason: "stdio not piped" });
      this.child = null;
      this.opts.onSpawnFailed?.();
      return;
    }
    this.generation += 1;
    this.opts.onWorkerStarted?.({ generation: this.generation, pid: child.pid });
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      // Request/response correlation first: a consumed response never reaches
      // the listeners (host-internal RPC); a non-consumed one is settled AND
      // still dispatched so downstream mirrors see the identical stream.
      if (this.settleMatchingRequest(line)) return;
      for (const listener of [...this.lineListeners]) {
        try {
          listener(line);
        } catch (e) {
          // A listener must never break worker streaming.
          this.log("line_listener.threw", { error: String(e) });
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.opts.onStderr?.(chunk.toString());
    });
    // A failed spawn (ENOENT/EACCES/EAGAIN/process-limit) emits 'error' and
    // NO 'exit'. Without this listener Node throws it as an uncaught
    // exception, and neither exit path fires, so pending host runs hang
    // forever. Treat a spawn error like a give-up crash.
    child.on("error", (err) => {
      this.log("child.error", { error: String(err) });
      try {
        rl.close();
      } catch {
        /* ignore */
      }
      this.child = null;
      this.outbox = [];
      this.settlePendingOnExit();
      this.opts.onSpawnError?.(err);
    });
    child.on("exit", (code, signal) => {
      // Close the readline interface bound to the dead child's stdout so it
      // (and its "line" listener) doesn't leak across restarts.
      rl.close();
      this.log("child.exit", { code, signal, pid: child.pid });
      this.child = null;
      this.outbox = []; // any queued messages were for the dead child; drop
      this.settlePendingOnExit();
      if (code === 0 && signal === null) {
        // Normal completion. Reset restart counter — clean exits don't count.
        this.restartCount = 0;
        this.opts.onExit?.({ code, signal, clean: true, gaveUp: false });
        return;
      }
      // Real crash. Note it but DON'T pre-emptively respawn — the next run
      // will trigger a fresh spawn anyway. We just decide whether to declare
      // "gave up" so the host can surface it.
      const gaveUp = this.shouldDeclareGaveUp();
      if (gaveUp) this.log("crash.gave_up", { restartCount: this.restartCount });
      else this.log("crash.tolerable", { restartCount: this.restartCount });
      this.opts.onExit?.({ code, signal, clean: false, gaveUp });
    });
    // Flush queued lines now that stdin exists.
    for (const queued of this.outbox) {
      child.stdin.write(queued + "\n");
    }
    this.outbox = [];
  }

  /** Returns true after >= restartLimit crashes in the current window. */
  private shouldDeclareGaveUp(): boolean {
    const now = Date.now();
    if (now - this.restartWindowStart > this.restartWindowMs) {
      this.restartWindowStart = now;
      this.restartCount = 0;
    }
    this.restartCount++;
    return this.restartCount > this.restartLimit;
  }

  /**
   * If `line` is a response to a pending request(), settle it. Returns true
   * when the line was consumed (must NOT be dispatched to listeners).
   */
  private settleMatchingRequest(line: string): boolean {
    if (this.pendingRequests.size === 0) return false;
    let msg: { id?: string | number; result?: unknown; error?: { message?: string; code?: number } };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return false;
    }
    if (msg.id === undefined || msg.id === null) return false;
    const pending = this.pendingRequests.get(msg.id);
    if (!pending) return false;
    pending.settle(
      msg.error
        ? { status: "error", error: msg.error }
        : { status: "result", result: msg.result },
    );
    return pending.consume;
  }

  private settlePendingOnExit(): void {
    for (const pending of [...this.pendingRequests.values()]) {
      if (pending.settleOnExit) pending.settle({ status: "workerExit" });
    }
  }

  /**
   * Register an observer of every worker stdout line that wasn't consumed by
   * a `consume: true` request. Returns an unsubscribe. A throwing listener
   * never disrupts the stream.
   */
  subscribeLines(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener);
    return () => this.lineListeners.delete(listener);
  }

  /**
   * Write one JSON-RPC line to the worker's stdin (newline appended). Returns
   * false when there is no live worker (caller decides drop/fallback). A
   * stream write error propagates to the caller, matching a direct write.
   */
  sendLine(line: string): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) return false;
    stdin.write(line + "\n");
    return true;
  }

  /**
   * Inject a JSON-RPC line into the worker exactly as a first-party front end
   * would. The host's `prepareInbound` hook runs first (metadata rewriting +
   * on-demand spawn side effects); the possibly-rewritten line is then
   * written, or dropped with a log when no worker is alive — identical
   * semantics for every front end (renderer, mobile remote, orchestrators).
   */
  injectWorkerMessage(rawLine: string): void {
    const prep = this.opts.prepareInbound
      ? this.opts.prepareInbound(rawLine)
      : { line: rawLine, method: undefined };
    if (!this.canSend()) {
      this.log("inject.dropped", {
        reason: this.child ? "stdin destroyed" : "no child",
        method: prep.method,
      });
      return;
    }
    this.log("inject→worker", { method: prep.method, raw: previewLine(prep.line) });
    this.sendLine(prep.line);
  }

  /**
   * Send a correlated JSON-RPC request and await its response by id.
   * `params` is omitted from the frame when undefined. Never rejects — the
   * outcome union carries error/timeout/send-failure states for the caller
   * to map onto its own semantics.
   */
  request(
    method: string,
    params: unknown,
    options: WorkerRequestOptions,
  ): Promise<WorkerRpcOutcome> {
    const { id } = options;
    return new Promise((resolve) => {
      let settled = false;
      const settle = (outcome: WorkerRpcOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        resolve(outcome);
      };
      const timer = setTimeout(() => settle({ status: "timeout" }), options.timeoutMs);
      this.pendingRequests.set(id, {
        consume: options.consume === true,
        settleOnExit: options.settleOnExit === true,
        settle,
      });
      const frame = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      });
      // Wake a lazily-unspawned worker before writing, so a spawn-triggering
      // request (pet/IM-gateway agent/run) isn't dropped by sendLine and left
      // to hang until timeout. Idempotent when a child is already alive.
      if (options.ensureWorker) this.ensureWorker(options.ensureWorkerCwd);
      let sent = false;
      let sendError: unknown;
      try {
        sent = this.sendLine(frame);
      } catch (e) {
        sendError = e;
      }
      if (options.failFast && (!sent || sendError !== undefined)) {
        settle({ status: "sendFailed", error: sendError });
      }
    });
  }

  /** Graceful shutdown: SIGTERM the worker (no-op when none is alive). */
  kill(): void {
    this.log("kill", { pid: this.child?.pid });
    this.child?.kill("SIGTERM");
  }
}

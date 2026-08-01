/**
 * NDJSON JSON-RPC client for `codex app-server`.
 *
 * Shapes verified against real `codex-cli 0.145.0` generated bindings; the
 * ordering and framing rules below are the expensive lessons recorded in the
 * `makecindy/cindy` reference implementation (design §16), which we read rather
 * than rediscover:
 *
 *  - **Codex's JSON-RPC does NOT send a `jsonrpc` field.** Messages must be
 *    discriminated by shape alone.
 *  - **Handlers must be registered before `initialize()`.** The server pushes
 *    notifications the moment the transport is up; registering afterwards drops
 *    them. There is no readiness banner — the `initialize` response IS readiness.
 *  - **A server→client request must always be answered**, even an unknown one, or
 *    the server blocks waiting.
 *  - **`request()` has no default timeout.** Per protocol a response may be
 *    arbitrarily late, and a global timeout manufactures orphan turns: a timed-out
 *    `turn/start` does NOT mean the server declined to create the turn. Callers
 *    opt in per call site.
 *  - **A single malformed line must not kill the session** (the server may emit a
 *    banner), but an oversized line must, to keep JSON.parse off the hot path.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

/** Cap per NDJSON line. Generous for reasoning text; guards parse latency. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;

export interface AppServerClientOptions {
  /** Executable; defaults to `codex` on PATH. */
  command?: string;
  /**
   * Full argv after `command`. Defaults to `["app-server"]`.
   *
   * Configurable rather than hardcoded so a test can point the client at a fake
   * server binary — a client that can only ever launch the real Codex is a client
   * whose transport rules are untestable without a login.
   */
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Structured log sink. Never receives tokens or full tool arguments. */
  log?: (event: string, data: Record<string, unknown>) => void;
}

export type NotificationHandler = (method: string, params: unknown) => void;

/**
 * Answer a server→client request. Returning `undefined` means "not handled",
 * which the client turns into a JSON-RPC method-not-found reply — the server is
 * waiting either way.
 */
export type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class CodexAppServerClient {
  private child?: ChildProcessWithoutNullStreams;
  private lines?: Interface;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private notificationHandler?: NotificationHandler;
  private requestHandler?: ServerRequestHandler;
  private closed = false;
  private closeReason?: string;
  /** Buffer lines that arrive before a handler exists, then drain in order. */
  private readonly preHandlerLines: string[] = [];
  private handlersReady = false;
  private readonly log: (event: string, data: Record<string, unknown>) => void;

  constructor(private readonly options: AppServerClientOptions = {}) {
    this.log = options.log ?? (() => {});
  }

  /**
   * Register handlers. MUST be called before {@link start} — see the note on
   * ordering in the module header.
   */
  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.requestHandler = handler;
  }

  /** Spawn the app-server. Handlers must already be registered. */
  start(): void {
    if (this.child) return;
    const command = this.options.command ?? "codex";
    const args = [...(this.options.args ?? ["app-server"])];
    // `shell: false` deliberately: a shell would reintroduce env-injection risk
    // and make stdio piping unpredictable.
    this.child = spawn(command, args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.setEncoding("utf8");
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.acceptLine(line));

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      // stderr is not protocol data. Log only a classification: it can carry
      // model output and must not become an auth-failure oracle either — auth
      // invalidation is detected ONLY from a correlated JSON-RPC error.
      // Diagnostic preview only, bounded; stderr is never an auth oracle.
      if (text) this.log("appserver.stderr", { bytes: text.length, preview: text.slice(0, 300) });
    });

    const onGone = (why: string) => (): void => this.failAll(why);
    this.child.on("exit", onGone("app-server exited"));
    this.child.on("error", onGone("app-server failed to start"));
    // Handlers are registered by contract before start(); release the buffer.
    this.handlersReady = true;
    for (const line of this.preHandlerLines.splice(0)) this.handleLine(line);
  }

  private acceptLine(line: string): void {
    if (!this.handlersReady) {
      this.preHandlerLines.push(line);
      return;
    }
    this.handleLine(line);
  }

  private handleLine(line: string): void {
    if (line.length > MAX_LINE_BYTES) {
      // Oversized is a transport failure: parsing it would stall the event loop.
      this.failAll("app-server sent an oversized line");
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // One bad line does not kill the session — the server may emit a banner.
      this.log("appserver.unparsable_line", { bytes: line.length });
      return;
    }

    // Shape-based discrimination: Codex omits the `jsonrpc` field entirely.
    const hasId = message.id !== undefined && message.id !== null;
    const method = typeof message.method === "string" ? message.method : undefined;

    if (hasId && method) {
      void this.dispatchServerRequest(message.id, method, message.params);
      return;
    }
    if (hasId) {
      this.settle(message);
      return;
    }
    if (method) {
      try {
        this.notificationHandler?.(method, message.params);
      } catch (error) {
        // A handler throw must not take down the read loop.
        this.log("appserver.notification_handler_failed", {
          method,
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    }
  }

  private settle(message: Record<string, unknown>): void {
    const id = Number(message.id);
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if (message.error !== undefined) {
      entry.reject(new Error(`app-server error: ${JSON.stringify(message.error).slice(0, 400)}`));
      return;
    }
    entry.resolve(message.result);
  }

  /**
   * Fire-and-forget so an awaiting client request never blocks inbound reads —
   * a server request arriving mid-flight must not deadlock the transport.
   */
  private async dispatchServerRequest(id: unknown, method: string, params: unknown): Promise<void> {
    try {
      const result = this.requestHandler ? await this.requestHandler(method, params) : undefined;
      if (result === undefined) {
        // The server is waiting regardless; an unhandled request still gets an
        // answer rather than a hang.
        this.write({ id, error: { code: -32601, message: `unhandled: ${method}` } });
        return;
      }
      this.write({ id, result });
    } catch (error) {
      this.write({
        id,
        error: { code: -32603, message: error instanceof Error ? error.message : "handler failed" },
      });
    }
  }

  /**
   * Send a request. No timeout unless `timeoutMs` is given — see the module
   * header on why a global timeout is harmful.
   */
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error(this.closeReason ?? "app-server client is closed"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry: Pending = { resolve, reject };
      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(
            new Error(
              `app-server ${method} did not answer within ${timeoutMs}ms. NOTE: the ` +
                `request may still have taken effect — a timed-out turn/start does not ` +
                `mean the turn was not created.`,
            ),
          );
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this.write({ id, method, params: params ?? {} });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write({ method, params: params ?? {} });
  }

  private write(payload: Record<string, unknown>): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private failAll(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    this.log("appserver.closed", { reason });
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Graceful stop: stdin EOF (the Rust app-server exits on it), SIGTERM after. */
  async close(): Promise<void> {
    const child = this.child;
    this.failAll("app-server client closed");
    this.lines?.close();
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* already gone */
    }
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), 2_000);
    await exited;
    clearTimeout(timer);
  }
}

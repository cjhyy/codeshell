import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";

const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_READY_TIMEOUT_MS = 20_000;
const DEFAULT_READY_INTERVAL_MS = 500;
const DEFAULT_METRICS_PORT = 20741;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 5_000;
const DEFAULT_HEALTH_FAILURE_THRESHOLD = 3;
// cloudflared handles SIGTERM but does NOT exit promptly (graceful drain,
// default ~30s per cloudflared docs). Give it a short grace, then SIGKILL so
// the fixed metrics port is released before we re-spawn — otherwise the new
// process can't bind 127.0.0.1:20741 and exits code=1.
const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_KILL_HARD_TIMEOUT_MS = 3_000;

export type TunnelStatus = "connected" | "disconnected" | "error";

export type SpawnFn = (
  command: string,
  args: string[],
) => ChildProcess;

/** Probe cloudflared's local metrics `/ready` endpoint; true once the edge
 *  connection count is > 0. Default implementation fetches over loopback. */
export type CheckReadyFn = (metricsPort: number) => Promise<boolean>;

async function defaultCheckReady(metricsPort: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${metricsPort}/ready`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { readyConnections?: number };
    return (body.readyConnections ?? 0) > 0;
  } catch {
    return false;
  }
}

export interface TunnelManagerOptions {
  /** Path to the cloudflared binary (from CloudflaredBinary.binaryPath()). */
  binaryPath: () => string;
  /** Injectable spawn for tests. */
  spawn?: SpawnFn;
  /** How long to wait for the tunnel URL before failing. Default 15s. */
  timeoutMs?: number;
  /** Local metrics port cloudflared exposes (we poll its /ready). */
  metricsPort?: number;
  /** Injectable readiness probe for tests. */
  checkReady?: CheckReadyFn;
  /** How long to wait for the edge connection to become ready. Default 20s. */
  readyTimeoutMs?: number;
  /** Poll interval while waiting for readiness. Default 500ms. */
  readyIntervalMs?: number;
  /** Poll interval after connect; set <= 0 to disable runtime health checks. */
  healthCheckIntervalMs?: number;
  /** Consecutive failed readiness probes before reporting a disconnect. */
  healthFailureThreshold?: number;
  /** Grace after SIGTERM before escalating to SIGKILL when tearing a child down. */
  killGraceMs?: number;
  /** Absolute cap on waiting for a killed child to exit (SIGKILL already sent). */
  killHardTimeoutMs?: number;
}

/**
 * Owns the cloudflared *process* only. `start` spawns a temporary tunnel and
 * resolves once the `https://*.trycloudflare.com` URL appears on stdout/stderr;
 * if no URL arrives within the timeout it kills the child and rejects. After a
 * successful start, an unsolicited child exit (crash) emits a `disconnected`
 * status — we deliberately do NOT auto-restart (spec decision: a silent
 * address change without a refreshed QR is worse than a visible disconnect).
 * `stop()` kills the child and suppresses the disconnected event.
 */
export class TunnelManager extends EventEmitter {
  private readonly getBinaryPath: () => string;
  private readonly spawn: SpawnFn;
  private readonly timeoutMs: number;
  private readonly metricsPort: number;
  private readonly checkReady: CheckReadyFn;
  private readonly readyTimeoutMs: number;
  private readonly readyIntervalMs: number;
  private readonly healthCheckIntervalMs: number;
  private readonly healthFailureThreshold: number;
  private readonly killGraceMs: number;
  private readonly killHardTimeoutMs: number;
  private child?: ChildProcess;
  /** In-flight teardown of a previous child. Any start() awaits this first so a
   *  new cloudflared never spawns while the old one still owns the metrics port. */
  private pendingTeardown?: Promise<void>;
  private stopping = false;
  private connected = false;
  private currentUrl?: string;
  private healthTimer?: ReturnType<typeof setInterval>;
  private healthCheckInFlight = false;
  private healthGeneration = 0;
  private consecutiveHealthFailures = 0;

  constructor(opts: TunnelManagerOptions) {
    super();
    this.getBinaryPath = opts.binaryPath;
    this.spawn = opts.spawn ?? nodeSpawn;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.metricsPort = opts.metricsPort ?? DEFAULT_METRICS_PORT;
    this.checkReady = opts.checkReady ?? defaultCheckReady;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.readyIntervalMs = opts.readyIntervalMs ?? DEFAULT_READY_INTERVAL_MS;
    this.healthCheckIntervalMs = opts.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
    this.healthFailureThreshold = Math.max(
      1,
      opts.healthFailureThreshold ?? DEFAULT_HEALTH_FAILURE_THRESHOLD,
    );
    this.killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.killHardTimeoutMs = opts.killHardTimeoutMs ?? DEFAULT_KILL_HARD_TIMEOUT_MS;
  }

  async start(port: number): Promise<{ url: string }> {
    // A previous cloudflared may still be around: a *soft* disconnect (edge
    // /ready lost) deliberately keeps the child alive so it can auto-recover,
    // so `this.child` can be set here even though the UI shows "disconnected".
    // Blindly throwing "隧道已在运行" (or spawning immediately) is exactly the
    // bug that forced a full app restart: the old process still holds the fixed
    // metrics port, so the fresh cloudflared can't bind it and exits code=1.
    // Tear the stale child down and WAIT for it to actually exit (freeing the
    // port) before starting fresh, so re-opening always works.
    // Tear down a still-live child (soft disconnect keeps it alive) AND await
    // any teardown already in flight from a prior stop()/failure — the old
    // cloudflared must fully exit and release 127.0.0.1:20741 before we spawn,
    // or the new one fails to bind and exits code=1 (the app-restart bug).
    if (this.child) {
      await this.beginTeardown();
    } else if (this.pendingTeardown) {
      await this.pendingTeardown;
    }
    this.stopping = false;
    this.connected = false;
    this.currentUrl = undefined;
    this.stopHealthMonitor();
    const child = this.spawn(this.getBinaryPath(), [
      "tunnel",
      "--no-autoupdate",
      // Force http2 (TCP). cloudflared defaults to QUIC (UDP/7844), which is
      // blocked on many networks (corp Wi-Fi, some carriers) — the connection
      // object registers but never becomes ready, so the phone hits Cloudflare
      // error 1033. http2 falls back to TCP/443 and reliably connects.
      "--protocol",
      "http2",
      // Fixed local metrics endpoint so we can poll /ready for edge readiness.
      "--metrics",
      `127.0.0.1:${this.metricsPort}`,
      "--url",
      `http://127.0.0.1:${port}`,
    ]);
    this.child = child;

    return new Promise<{ url: string }>((resolve, reject) => {
      let settled = false;

      const finishReject = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Route through the shared teardown so a retried start() awaits this
        // child's real exit (releasing the metrics port) before re-spawning.
        void this.beginTeardown();
        reject(err);
      };

      const timer = setTimeout(() => {
        finishReject(new Error("隧道启动失败:15s 内未取得公网地址(超时)"));
      }, this.timeoutMs);

      const scan = (buf: Buffer | string) => {
        if (settled) return;
        const match = TRYCLOUDFLARE_RE.exec(String(buf));
        if (!match) return;
        // URL captured, but the edge connection is NOT necessarily ready yet —
        // resolving here was the 1033 bug (handing back a dead QR). Stop the
        // URL scanners and wait for /ready before declaring connected.
        child.stdout?.off("data", scan);
        child.stderr?.off("data", scan);
        clearTimeout(timer);
        const url = match[0];
        this.waitForReady()
          .then(() => {
            if (settled) return;
            settled = true;
            this.connected = true;
            this.currentUrl = url;
            this.emit("status", "connected", url);
            this.startHealthMonitor();
            resolve({ url });
          })
          .catch((err: Error) => finishReject(err));
      };

      child.stdout?.on("data", scan);
      child.stderr?.on("data", scan);

      child.on("error", (err) => {
        // A superseded child (torn down by a restart) must not touch shared
        // state — killAndWait owns its exit. Only the live child reports errors.
        if (this.child !== child && settled) return;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.child = undefined;
          this.connected = false;
          this.currentUrl = undefined;
          this.stopHealthMonitor();
          this.emit("status", "error", err);
          reject(err);
        } else if (!this.stopping) {
          this.emit("status", "error", err);
        }
      });

      child.on("exit", (code, signal) => {
        // A superseded child (torn down by stop()/restart) exiting must NOT
        // clear this.child / connected / health — those now belong to the new
        // tunnel. killAndWait already awaits this exit; ignore it here.
        if (this.child !== child) return;
        const wasConnected = this.connected;
        this.child = undefined;
        this.connected = false;
        this.currentUrl = undefined;
        this.stopHealthMonitor();
        if (this.stopping) return;
        if (wasConnected) {
          this.emit("status", "disconnected", { code, signal });
        } else if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`cloudflared 退出(code=${code ?? "?"} signal=${signal ?? "?"})`));
        }
      });
    });
  }

  /**
   * Poll cloudflared's /ready until the edge connection is up, or reject after
   * `readyTimeoutMs`. This is what distinguishes a working tunnel from one that
   * registered a connection but can't actually serve traffic (error 1033).
   */
  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    for (;;) {
      if (this.child && (await this.checkReady(this.metricsPort))) return;
      if (Date.now() >= deadline) {
        throw new Error(
          "隧道注册失败:公网边缘连接未就绪(可能网络限制,扫码会报 1033)",
        );
      }
      await new Promise((r) => setTimeout(r, this.readyIntervalMs));
    }
  }

  private startHealthMonitor(): void {
    this.stopHealthMonitor();
    if (this.healthCheckIntervalMs <= 0) return;
    this.consecutiveHealthFailures = 0;
    const generation = ++this.healthGeneration;
    const timer = setInterval(() => {
      void this.pollHealth(generation);
    }, this.healthCheckIntervalMs);
    (timer as { unref?: () => void }).unref?.();
    this.healthTimer = timer;
  }

  private stopHealthMonitor(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = undefined;
    this.healthGeneration += 1;
    this.healthCheckInFlight = false;
    this.consecutiveHealthFailures = 0;
  }

  private async pollHealth(generation: number): Promise<void> {
    if (
      generation !== this.healthGeneration ||
      this.healthCheckInFlight ||
      !this.child ||
      this.stopping
    ) {
      return;
    }
    this.healthCheckInFlight = true;
    try {
      const ready = await this.checkReady(this.metricsPort);
      if (generation !== this.healthGeneration || !this.child || this.stopping) return;
      if (ready) {
        this.consecutiveHealthFailures = 0;
        if (!this.connected) {
          this.connected = true;
          this.emit("status", "connected", this.currentUrl);
        }
        return;
      }
      this.consecutiveHealthFailures += 1;
      if (this.connected && this.consecutiveHealthFailures >= this.healthFailureThreshold) {
        this.connected = false;
        this.emit("status", "disconnected", {
          reason: "ready-check-failed",
          consecutiveFailures: this.consecutiveHealthFailures,
        });
      }
    } catch (err) {
      if (generation !== this.healthGeneration || !this.child || this.stopping) return;
      this.emit("status", "error", err);
    } finally {
      if (generation === this.healthGeneration) {
        this.healthCheckInFlight = false;
      }
    }
  }

  /**
   * Tear the current child down and remember the wait as `pendingTeardown` so a
   * subsequent start() blocks until the process has really exited (freeing the
   * metrics port). Shared by stop(), startup-failure, and restart so there is a
   * single teardown path — the missing shared wait was the stop()→start() race.
   * Idempotent: with no live child it resolves immediately.
   */
  private beginTeardown(): Promise<void> {
    this.stopping = true;
    this.connected = false;
    this.currentUrl = undefined;
    this.stopHealthMonitor();
    const child = this.child;
    this.child = undefined;
    if (!child) {
      this.pendingTeardown = undefined;
      return Promise.resolve();
    }
    const wait = this.killAndWait(child).finally(() => {
      // Only clear if no newer teardown superseded this one.
      if (this.pendingTeardown === wait) this.pendingTeardown = undefined;
    });
    this.pendingTeardown = wait;
    return wait;
  }

  /**
   * SIGTERM the child, and if it hasn't exited within `killGraceMs`, escalate to
   * SIGKILL — cloudflared's SIGTERM is a graceful drain (default ~30s) that
   * would otherwise keep the metrics port bound long past a re-open. Resolves
   * only when the process actually exits (`killHardTimeoutMs` is a last-resort
   * cap so we never hang forever if the OS never reports exit).
   */
  private killAndWait(child: ChildProcess): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(graceTimer);
        clearTimeout(hardTimer);
        resolve();
      };
      child.once("exit", finish);
      try {
        child.kill("SIGTERM");
      } catch {
        finish();
        return;
      }
      const graceTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, this.killGraceMs);
      const hardTimer = setTimeout(finish, this.killHardTimeoutMs);
      (graceTimer as { unref?: () => void }).unref?.();
      (hardTimer as { unref?: () => void }).unref?.();
    });
  }

  /**
   * Kill the cloudflared child and suppress the disconnect event. Returns a
   * promise that resolves once the process has actually exited so callers that
   * immediately restart don't race the port. Fire-and-forget callers may ignore
   * it (kept sync-compatible: existing `tunnelManager.stop()` sites work).
   */
  stop(): Promise<void> {
    return this.beginTeardown();
  }

  isRunning(): boolean {
    return Boolean(this.child);
  }

  isConnected(): boolean {
    return this.connected;
  }
}

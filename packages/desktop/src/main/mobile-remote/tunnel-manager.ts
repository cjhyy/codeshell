import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";

const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_READY_TIMEOUT_MS = 20_000;
const DEFAULT_READY_INTERVAL_MS = 500;
const DEFAULT_METRICS_PORT = 20741;

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
  private child?: ChildProcess;
  private stopping = false;
  private connected = false;

  constructor(opts: TunnelManagerOptions) {
    super();
    this.getBinaryPath = opts.binaryPath;
    this.spawn = opts.spawn ?? nodeSpawn;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.metricsPort = opts.metricsPort ?? DEFAULT_METRICS_PORT;
    this.checkReady = opts.checkReady ?? defaultCheckReady;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.readyIntervalMs = opts.readyIntervalMs ?? DEFAULT_READY_INTERVAL_MS;
  }

  start(port: number): Promise<{ url: string }> {
    if (this.child) {
      throw new Error("隧道已在运行");
    }
    this.stopping = false;
    this.connected = false;
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
        this.stopping = true;
        child.kill("SIGTERM");
        this.child = undefined;
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
            this.emit("status", "connected", url);
            resolve({ url });
          })
          .catch((err: Error) => finishReject(err));
      };

      child.stdout?.on("data", scan);
      child.stderr?.on("data", scan);

      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.child = undefined;
          this.emit("status", "error", err);
          reject(err);
        } else if (!this.stopping) {
          this.emit("status", "error", err);
        }
      });

      child.on("exit", (code, signal) => {
        this.child = undefined;
        if (this.stopping) return;
        if (this.connected) {
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

  /** Kill the cloudflared child (SIGTERM) and suppress the disconnect event. */
  stop(): void {
    this.stopping = true;
    this.connected = false;
    const child = this.child;
    this.child = undefined;
    child?.kill("SIGTERM");
  }

  isRunning(): boolean {
    return Boolean(this.child);
  }
}

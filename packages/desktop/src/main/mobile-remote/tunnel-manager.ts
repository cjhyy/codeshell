import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";

const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const DEFAULT_TIMEOUT_MS = 15_000;

export type TunnelStatus = "connected" | "disconnected" | "error";

export type SpawnFn = (
  command: string,
  args: string[],
) => ChildProcess;

export interface TunnelManagerOptions {
  /** Path to the cloudflared binary (from CloudflaredBinary.binaryPath()). */
  binaryPath: () => string;
  /** Injectable spawn for tests. */
  spawn?: SpawnFn;
  /** How long to wait for the tunnel URL before failing. Default 15s. */
  timeoutMs?: number;
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
  private child?: ChildProcess;
  private stopping = false;
  private connected = false;

  constructor(opts: TunnelManagerOptions) {
    super();
    this.getBinaryPath = opts.binaryPath;
    this.spawn = opts.spawn ?? nodeSpawn;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
      "--url",
      `http://127.0.0.1:${port}`,
    ]);
    this.child = child;

    return new Promise<{ url: string }>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.stopping = true;
        child.kill("SIGTERM");
        this.child = undefined;
        reject(new Error("隧道启动失败:15s 内未取得公网地址(超时)"));
      }, this.timeoutMs);

      const scan = (buf: Buffer | string) => {
        if (settled) return;
        const match = TRYCLOUDFLARE_RE.exec(String(buf));
        if (!match) return;
        settled = true;
        clearTimeout(timer);
        this.connected = true;
        this.emit("status", "connected", match[0]);
        resolve({ url: match[0] });
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

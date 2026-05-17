/**
 * Stream Idle Watchdog — guarantees an upper bound on the time a streaming
 * LLM call can spend with no bytes arriving. Without this, a wedged HTTP/2
 * connection can hang the session indefinitely; the SDK's request timeout
 * only covers the initial fetch, not the streaming body.
 *
 * Disabled by default. Enabled via env CODESHELL_ENABLE_STREAM_WATCHDOG=1.
 */

export interface StreamWatchdogOptions {
  /** Abort the stream when no chunks arrive within this window. */
  idleTimeoutMs: number;
  /** Called when the watchdog decides to abort. */
  onTimeout: () => void;
  /**
   * Called at idleTimeoutMs/2 (or warningMs if provided). Logging only —
   * the watchdog does not abort on warning. The argument is the configured
   * warning threshold (NOT real-time elapsed) so callers can format the log
   * without re-deriving it.
   */
  onWarning?: (warnThresholdMs: number) => void;
  /** Override the warning trigger; defaults to idleTimeoutMs / 2. */
  warningMs?: number;
}

export interface StreamWatchdog {
  /** Re-arm both timers — call after every chunk. */
  reset(): void;
  /** Clear all timers permanently — call in finally. */
  dispose(): void;
}

export class StreamIdleTimeoutError extends Error {
  readonly kind = "stream-idle-timeout";
  constructor(
    public idleMs: number,
    public requestId?: string,
  ) {
    super(`Stream idle for ${idleMs}ms — aborted`);
    this.name = "StreamIdleTimeoutError";
  }
}

export function createStreamWatchdog(opts: StreamWatchdogOptions): StreamWatchdog {
  const warnMs = opts.warningMs ?? Math.floor(opts.idleTimeoutMs / 2);
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let warnTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function arm(): void {
    if (disposed) return;
    if (opts.onWarning) {
      warnTimer = setTimeout(() => {
        if (disposed) return;
        opts.onWarning?.(warnMs);
      }, warnMs);
    }
    idleTimer = setTimeout(() => {
      if (disposed) return;
      opts.onTimeout();
    }, opts.idleTimeoutMs);
  }

  function clear(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (warnTimer !== null) {
      clearTimeout(warnTimer);
      warnTimer = null;
    }
  }

  arm();

  return {
    reset() {
      if (disposed) return;
      clear();
      arm();
    },
    dispose() {
      disposed = true;
      clear();
    },
  };
}

/** Environment-driven defaults. Read once at import time is fine — these never change inside a process. */
export const STREAM_WATCHDOG_CONFIG = {
  enabled: process.env.CODESHELL_ENABLE_STREAM_WATCHDOG === "1",
  idleTimeoutMs:
    parseInt(process.env.CODESHELL_STREAM_IDLE_TIMEOUT_MS || "", 10) || 90_000,
  retries:
    parseInt(process.env.CODESHELL_STREAM_WATCHDOG_RETRIES || "", 10) || 2,
};

/** Minimal surface we need from a server to shut it down cleanly. */
interface Closable {
  close(): void;
}

/** Minimal surface we need from `process` (injectable for tests). */
interface ProcLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  exit(code?: number): void;
}

export interface GracefulShutdownOptions {
  /** Defaults to the real `process`. */
  proc?: ProcLike;
  /** Signals to handle. Defaults to SIGTERM, SIGINT, SIGHUP. */
  signals?: string[];
}

/**
 * Register signal handlers that cleanly shut down a long-lived server before
 * the process exits. Without this, SIGTERM/SIGINT (Ctrl+C)/SIGHUP terminate
 * the process immediately, leaking the idle sweeper interval, open sessions,
 * pending approvals, and child processes (MCP servers, tools).
 *
 * Idempotent: the first signal runs close() exactly once; later signals (or a
 * second handler firing) are ignored. A throwing close() is swallowed so the
 * process still exits.
 */
export function installGracefulShutdown(
  server: Closable,
  options: GracefulShutdownOptions = {},
): void {
  const proc = options.proc ?? (globalThis.process as unknown as ProcLike);
  const signals = options.signals ?? ["SIGTERM", "SIGINT", "SIGHUP"];

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      server.close();
    } catch {
      // Best-effort cleanup — never block exit on a close() failure.
    }
    proc.exit(0);
  };

  for (const sig of signals) {
    proc.on(sig, shutdown);
  }
}

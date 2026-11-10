import { spawn } from "node:child_process";

/**
 * A child that exits 0 without reading all of its input closes the pipe under a
 * pending write. Like a shell pipeline ignoring SIGPIPE, that is not a failure.
 */
export function isBrokenPipeError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EPIPE";
}

/**
 * Terminate a single (non-detached) foreground child + its tree.
 *
 *  - POSIX: SIGTERM, then SIGKILL after `graceMs` if it ignored the term.
 *    (The child is the process-group leader of its own subtree only if it was
 *    spawned with its own group; safe-spawn's foreground children are not, so
 *    this kills the direct child — matching the historical behavior.)
 *  - Windows: `child.kill("SIGTERM")` is a no-op and only kills the direct
 *    child anyway, leaving grandchildren (e.g. `npm test → node`). Use
 *    `taskkill /T /F` on the pid to reap the whole tree. No graceful phase.
 *
 * Best-effort: never throws; a child that already exited is fine.
 */
export function killChildTree(
  child: { pid?: number; kill: (sig?: NodeJS.Signals) => boolean },
  graceMs: number,
): void {
  if (process.platform === "win32") {
    if (typeof child.pid === "number") void killProcessTreeWindows(child.pid);
    else
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    /* may already be dead */
  }
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }, graceMs).unref();
}

/**
 * Windows process-tree kill via `taskkill /PID <pid> /T /F`. Resolves when
 * taskkill exits (or immediately if the pid is already gone). Best-effort:
 * a non-zero exit (e.g. "process not found", code 128) is treated as success
 * since the goal — the tree being gone — is met.
 */
export function killProcessTreeWindows(pid: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolve();
      return;
    }
    child.on("error", () => resolve());
    child.on("exit", () => resolve());
  });
}

import type { ChildProcess } from "node:child_process";

/** Retire an unusable room transport without leaving an unresponsive CLI alive. */
export function stopRoomProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const signal = (value: NodeJS.Signals): void => {
    if (child.pid && child.pid > 1 && process.platform !== "win32") {
      try {
        process.kill(-child.pid, value);
        return;
      } catch {
        /* A failed spawn or an exited group falls back to the exact child. */
      }
    }
    try {
      child.kill(value);
    } catch {
      /* already gone */
    }
  };
  signal("SIGTERM");
  if (!child.pid) return;
  const timer = setTimeout(() => signal("SIGKILL"), 1_000);
  timer.unref();
  child.once("exit", () => clearTimeout(timer));
}

/**
 * Resolve true once `child` has exited (or never started a process), false
 * when it is still alive after `timeoutMs`. A replacement CLI for the same
 * external session may only start after this resolves true; otherwise two
 * processes could append to one transcript.
 */
export function waitForRoomProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined)
    return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    child.once("exit", onExit);
  });
}

/** Signal the process group, then wait (bounded) for the child to exit. */
export function stopRoomProcessAndWait(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const exited = waitForRoomProcessExit(child, timeoutMs);
  stopRoomProcess(child);
  return exited;
}

/**
 * Resolve once a just-spawned child exists. Node assigns `pid` synchronously
 * for a successful spawn; a failed spawn (missing command/cwd) has no pid and
 * reports the failure through `error` on a later tick.
 */
export function waitForRoomProcessSpawn(child: ChildProcess): Promise<void> {
  if (child.pid !== undefined) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (error) => reject(error));
  });
}

/**
 * `close` waits for every holder of the child's stdout/stderr. A grandchild the
 * CLI backgrounded with inherited stdio (a dev server, say) keeps them open
 * after the CLI exits, so the room would never settle. Once the CLI has exited
 * and its buffered output had a grace period to drain, release the pipes;
 * the grandchild itself is left running.
 */
export function releaseStdioAfterExit(child: ChildProcess, graceMs = 1_000): void {
  child.once("exit", () => {
    const timer = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
    }, graceMs);
    timer.unref();
    child.once("close", () => clearTimeout(timer));
  });
}

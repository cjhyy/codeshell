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

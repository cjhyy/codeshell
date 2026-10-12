import { execFileSync } from "node:child_process";
import { rememberOwnedProcesses } from "./process-custody.mjs";

function snapshotProcesses() {
  const output = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,lstart="], {
    encoding: "utf8",
    timeout: 1_500,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  return output.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    return match ? [{ pid: +match[1], ppid: +match[2], birth: match[3] }] : [];
  });
}

function reportFailure(message) {
  console.error(`[electron-test-watchdog] ${message}`);
  process.exitCode = 1;
}

/**
 * Bound macOS test Electron lifetime without signaling by process name or stale PID.
 * The returned function disarms monitoring. Cleanup already started by an exit or
 * timeout still gets its one-second grace period and identity-checked escalation.
 */
export function watchElectronTestProcess(child, options = {}) {
  const {
    timeoutMs = 180_000,
    platform = process.platform,
    parentPid = process.pid,
    snapshotProcesses: snapshot = snapshotProcesses,
    signalProcess = (pid, signal) => process.kill(pid, signal),
    setTimeout: scheduleTimeout = setTimeout,
    clearTimeout: cancelTimeout = clearTimeout,
    setInterval: scheduleInterval = setInterval,
    clearInterval: cancelInterval = clearInterval,
    reportFailure: fail = reportFailure,
  } = options;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
    throw new Error("Electron test timeoutMs must be an integer between 1 and 2147483647");
  // Other platform process identities need their own custody implementation.
  if (platform !== "darwin" || child.exitCode != null || child.signalCode != null) return () => {};

  let initial;
  try {
    initial = snapshot();
  } catch (error) {
    throw new Error(`Cannot establish Electron test process identity: ${error.message}`, {
      cause: error,
    });
  }
  const root = initial.find(
    (item) => item.pid === child.pid && item.ppid === parentPid && item.birth,
  );
  if (!root)
    throw new Error("Cannot establish Electron test child PID, parent PID and birth identity");
  const owned = new Map([[root.pid, root]]);
  rememberOwnedProcesses(owned, initial);
  let state = "watching";
  let snapshotFailureReported = false;

  const observe = () => {
    try {
      const current = snapshot();
      rememberOwnedProcesses(owned, current);
      return new Map(current.map((item) => [item.pid, item]));
    } catch (error) {
      if (!snapshotFailureReported) {
        snapshotFailureReported = true;
        fail(`Cannot inspect Electron test processes; unsafe cleanup skipped: ${error.message}`);
      }
      return new Map();
    }
  };
  const signalOwned = (signal, includeRoot) => {
    const current = observe();
    let count = 0;
    // Descendants are remembered after their parent, so the root is signaled last.
    for (const item of [...owned.values()].reverse()) {
      if ((!includeRoot && item.pid === root.pid) || current.get(item.pid)?.birth !== item.birth)
        continue;
      count += 1;
      try {
        signalProcess(item.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH")
          fail(
            `Cannot send ${signal} to owned Electron test process ${item.pid}: ${error.message}`,
          );
      }
    }
    return count;
  };
  const disarm = () => {
    cancelInterval(interval);
    cancelTimeout(deadline);
    child.removeListener("exit", onExit);
  };
  const cleanup = (includeRoot) => {
    state = "cleaning";
    disarm();
    if (signalOwned("SIGTERM", includeRoot)) {
      scheduleTimeout(() => {
        signalOwned("SIGKILL", includeRoot);
        state = "stopped";
      }, 1_000);
    } else state = "stopped";
  };
  const onExit = () => {
    if (state === "watching") cleanup(false);
  };
  child.once("exit", onExit);
  const interval = scheduleInterval(observe, 1_000);
  const deadline = scheduleTimeout(() => {
    if (state !== "watching") return;
    fail(
      `Electron test exceeded ${timeoutMs}ms; OS interaction may be pending. Stopping only this test's observed processes.`,
    );
    cleanup(true);
  }, timeoutMs);
  return () => {
    if (state !== "watching") return;
    state = "stopped";
    disarm();
  };
}

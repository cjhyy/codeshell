import { snapshotElectronTestProcesses } from "./electron-test-process-snapshot.mjs";
import { rememberOwnedProcesses } from "./process-custody.mjs";

function reportFailure(message) {
  console.error(`[electron-test-watchdog] ${message}`);
  process.exitCode = 1;
}

function completionEvidence(status, owned, remaining, queryFailed) {
  const bounded = (rows) =>
    rows.slice(0, 512).map(({ pid, ppid, birth }) => ({ pid, ppid, birth: birth.slice(0, 80) }));
  const all = [...owned.values()];
  return {
    status,
    owned: bounded(all),
    remaining: remaining === null ? null : bounded(remaining),
    ownedCount: all.length,
    remainingCount: remaining?.length ?? null,
    evidenceTruncated:
      all.length > 512 ||
      (remaining?.length ?? 0) > 512 ||
      all.some((row) => row.birth.length > 80),
    queryFailed,
  };
}

/**
 * Bound native test child lifetime without signaling by process name or stale PID.
 * The returned function disarms monitoring. Cleanup already started by an exit or
 * timeout still gets its one-second grace period and identity-checked escalation.
 * Its completed Promise proves cleanup only with status "cleaned"; manual disarm
 * and failed queries/residual processes resolve "disarmed" and "unproven".
 * terminate() requests the same identity-checked cleanup immediately and returns
 * completed. A disarmed or settled watcher never regains signaling authority.
 */
export function watchElectronTestProcess(child, options = {}) {
  const {
    timeoutMs = 180_000,
    platform = process.platform,
    parentPid = process.pid,
    snapshotProcesses: snapshot = () => snapshotElectronTestProcesses({ platform }),
    signalProcess = (pid, signal) => process.kill(pid, signal),
    setTimeout: scheduleTimeout = setTimeout,
    clearTimeout: cancelTimeout = clearTimeout,
    setInterval: scheduleInterval = setInterval,
    clearInterval: cancelInterval = clearInterval,
    reportFailure: fail = reportFailure,
    now = Date.now,
  } = options;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
    throw new Error("Electron test timeoutMs must be an integer between 1 and 2147483647");
  if (child.exitCode != null || child.signalCode != null) {
    const completed = Promise.resolve(completionEvidence("unproven", new Map(), null, false));
    return Object.assign(() => {}, {
      completed,
      terminate: () => completed,
    });
  }
  if (!["darwin", "linux", "win32"].includes(platform))
    throw new Error("Unsupported Electron test watchdog platform");

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
  let resolveCompleted;
  const completed = new Promise((resolve) => {
    resolveCompleted = resolve;
  });
  const finish = (status, remaining) => {
    state = "stopped";
    resolveCompleted(completionEvidence(status, owned, remaining, snapshotFailureReported));
  };

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
      return null;
    }
  };
  const signalOwned = (signal, includeRoot) => {
    const candidates = observe();
    if (!candidates || snapshotFailureReported) return 0;
    let count = 0;
    // Descendants are remembered after their parent, so the root is signaled last.
    for (const item of [...owned.values()].reverse()) {
      if (!includeRoot && item.pid === root.pid) continue;
      // An incarnation already absent from this fresh discovery cannot be a
      // signal candidate. Avoid a separate native query for each departed PID.
      if (candidates.get(item.pid)?.birth !== item.birth) continue;
      // A preceding signal/query may race process exit and PID reuse. Recheck
      // this exact incarnation immediately before each individual signal.
      const current = observe();
      if (!current || snapshotFailureReported) break;
      if (current.get(item.pid)?.birth !== item.birth) continue;
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
  const confirmStopped = (deadline = now() + 3_000) => {
    if (snapshotFailureReported) {
      finish("unproven", null);
      return;
    }
    const current = observe();
    if (!current) {
      finish("unproven", null);
      return;
    }
    const remaining = [...owned.values()].filter(
      (item) => current.get(item.pid)?.birth === item.birth,
    );
    if (!remaining.length) finish("cleaned", []);
    else if (now() >= deadline) {
      fail("Cannot confirm that every observed Electron test process incarnation terminated");
      finish("unproven", remaining);
    } else scheduleTimeout(() => confirmStopped(deadline), 100);
  };
  const cleanup = (includeRoot) => {
    state = "cleaning";
    disarm();
    if (signalOwned("SIGTERM", includeRoot)) {
      scheduleTimeout(() => {
        signalOwned("SIGKILL", includeRoot);
        confirmStopped();
      }, 1_000);
    } else confirmStopped();
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
  const stop = () => {
    if (state !== "watching") return;
    disarm();
    finish("disarmed", null);
  };
  const terminate = () => {
    if (state === "watching") cleanup(true);
    return completed;
  };
  return Object.assign(stop, { completed, terminate });
}

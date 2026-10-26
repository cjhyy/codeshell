import { performance } from "node:perf_hooks";
import {
  snapshotElectronTestProcesses,
  snapshotElectronTestProcessesAsync,
} from "./electron-test-process-snapshot.mjs";
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
 * bindObservedDescendant(pid) freshly registers a real descendant while the
 * pinned root is still alive; it returns only its matched PID/parent/full birth.
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
    timingNow = () => performance.now(),
    onOwnedSnapshot,
    onInitialIdentityFailure,
  } = options;
  // Custom synchronous adapters may bind an advisory sidecar to that exact
  // query. Keep them paired unless they explicitly supply an async equivalent.
  const snapshotAsync =
    options.snapshotProcessesAsync ??
    (options.snapshotProcesses
      ? undefined
      : () => snapshotElectronTestProcessesAsync({ platform }));
  const timing = { count: 0, totalMs: 0, maxMs: 0, recent: [], maxTickGapMs: 0 };
  const snapshotTiming = () => ({ ...timing, recent: [...timing.recent] });
  const recordTiming = (started) => {
    const elapsed = Math.max(0, timingNow() - started);
    timing.count++;
    timing.totalMs += elapsed;
    timing.maxMs = Math.max(timing.maxMs, elapsed);
    timing.recent.push(elapsed);
    if (timing.recent.length > 32) timing.recent.shift();
  };
  const timedSnapshot = () => {
    const started = timingNow();
    try {
      return snapshot();
    } finally {
      recordTiming(started);
    }
  };
  const withTiming = (monitor) =>
    Object.defineProperty(monitor, "snapshotTiming", { get: snapshotTiming });
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
    throw new Error("Electron test timeoutMs must be an integer between 1 and 2147483647");
  if (child.exitCode != null || child.signalCode != null) {
    const completed = Promise.resolve(completionEvidence("unproven", new Map(), null, false));
    return withTiming(
      Object.assign(() => {}, {
        completed,
        terminate: () => completed,
        bindObservedDescendant: () => undefined,
      }),
    );
  }
  if (!["darwin", "linux", "win32"].includes(platform))
    throw new Error("Unsupported Electron test watchdog platform");

  let initial;
  try {
    initial = timedSnapshot();
  } catch (error) {
    throw new Error(`Cannot establish Electron test process identity: ${error.message}`, {
      cause: error,
    });
  }
  const root = initial.find(
    (item) => item.pid === child.pid && item.ppid === parentPid && item.birth,
  );
  if (!root) {
    if (typeof onInitialIdentityFailure === "function") {
      try {
        const safePid = (value) =>
          Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff ? value : null;
        const matches = [];
        let matchingPidRows = 0;
        for (const item of initial) {
          if (item.pid !== child.pid) continue;
          matchingPidRows++;
          if (matches.length === 4) continue;
          // Timestamp shape is diagnostic only; it never grants custody.
          const birthAvailable =
            typeof item.birth === "string" &&
            item.birth.length <= 80 &&
            /^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z|(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4})$/.test(
              item.birth,
            );
          matches.push({
            ppid: safePid(item.ppid),
            birthAvailable,
            birth: birthAvailable ? item.birth : null,
          });
        }
        onInitialIdentityFailure({
          schemaVersion: 1,
          targetPid: safePid(child.pid),
          expectedParentPid: safePid(parentPid),
          snapshotRows: initial.length,
          matchingPidRows,
          matches,
          truncated: matchingPidRows > matches.length,
          boundary:
            "Same initial snapshot rows only; diagnostic projection, not custody authority or process liveness.",
        });
      } catch {
        // Diagnostics never change the original missing-identity failure.
      }
    }
    throw new Error("Cannot establish Electron test child PID, parent PID and birth identity");
  }
  const owned = new Map([[root.pid, root]]);
  rememberOwnedProcesses(owned, initial);
  let state = "watching";
  let generation = 0,
    inFlight = false,
    lastTick = timingNow();
  const notifyOwnedSnapshot = (current, phase) => {
    if (typeof onOwnedSnapshot !== "function") return;
    try {
      // Copies only: observers cannot alter the authority snapshot or remembered map.
      const ownedCurrent = current
        .filter((item) => {
          const pinned = owned.get(item.pid);
          return pinned?.ppid === item.ppid && pinned?.birth === item.birth;
        })
        .map(({ pid, ppid, birth }) => ({ pid, ppid, birth }));
      onOwnedSnapshot({ phase, ownedCurrent });
    } catch {
      /* Advisory observers never interrupt identity checks or cleanup. */
    }
  };
  notifyOwnedSnapshot(initial, "initial");
  let snapshotFailureReported = false;
  let resolveCompleted;
  const completed = new Promise((resolve) => {
    resolveCompleted = resolve;
  });
  const finish = (status, remaining) => {
    state = "stopped";
    resolveCompleted(completionEvidence(status, owned, remaining, snapshotFailureReported));
  };

  const observationFailed = (error) => {
    if (!snapshotFailureReported) {
      snapshotFailureReported = true;
      fail(`Cannot inspect Electron test processes; unsafe cleanup skipped: ${error.message}`);
    }
  };
  const observe = () => {
    try {
      const current = timedSnapshot();
      rememberOwnedProcesses(owned, current);
      notifyOwnedSnapshot(current, state);
      return new Map(current.map((item) => [item.pid, item]));
    } catch (error) {
      observationFailed(error);
      return null;
    }
  };
  const poll = () => {
    if (state !== "watching") return;
    const tick = timingNow();
    timing.maxTickGapMs = Math.max(timing.maxTickGapMs, tick - lastTick);
    lastTick = tick;
    if (inFlight) return;
    if (!snapshotAsync) {
      observe();
      return;
    }
    inFlight = true;
    const currentGeneration = generation,
      started = timingNow();
    // Never await this query during cleanup. A stopped generation has no right
    // to adopt descendants, notify an observer or fail a settled monitor.
    void (async () => {
      try {
        const current = await snapshotAsync();
        if (generation !== currentGeneration || state !== "watching") return;
        rememberOwnedProcesses(owned, current);
        notifyOwnedSnapshot(current, state);
      } catch (error) {
        if (generation === currentGeneration && state === "watching") observationFailed(error);
      } finally {
        if (generation === currentGeneration && state === "watching") {
          recordTiming(started);
          inFlight = false;
        }
      }
    })();
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
    generation++;
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
  const interval = scheduleInterval(poll, 1_000);
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
  const bindObservedDescendant = (pid) => {
    if (
      state !== "watching" ||
      snapshotFailureReported ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      pid === root.pid
    )
      return undefined;
    const current = observe();
    if (
      !current ||
      snapshotFailureReported ||
      current.get(root.pid)?.birth !== root.birth ||
      current.get(root.pid)?.ppid !== root.ppid
    )
      return undefined;
    const fresh = current.get(pid);
    const pinned = owned.get(pid);
    if (!fresh || !pinned || fresh.birth !== pinned.birth || fresh.ppid !== pinned.ppid)
      return undefined;
    return { pid: fresh.pid, ppid: fresh.ppid, birth: fresh.birth };
  };
  return withTiming(Object.assign(stop, { completed, terminate, bindObservedDescendant }));
}

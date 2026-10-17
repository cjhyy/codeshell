import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { watchElectronTestProcess } from "./electron-test-watchdog.mjs";

const root = { pid: 10, ppid: 99, birth: "root" };
const descendant = { pid: 11, ppid: 10, birth: "descendant" };

function fixture(initial = [root]) {
  const child = Object.assign(new EventEmitter(), { pid: 10, exitCode: null, signalCode: null });
  const timeouts = new Map();
  const intervals = new Map();
  const signals = [];
  const failures = [];
  let processes = initial;
  let elapsed = 0;
  let nextTimer = 1;
  const add = (timers, callback, delay) => {
    const id = nextTimer++;
    timers.set(id, { callback, delay });
    return id;
  };
  return {
    child,
    timeouts,
    intervals,
    signals,
    failures,
    options: {
      platform: "darwin",
      parentPid: 99,
      timeoutMs: 5_000,
      snapshotProcesses: () => processes,
      signalProcess: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === "SIGKILL") processes = processes.filter((row) => row.pid !== pid);
      },
      now: () => elapsed,
      reportFailure: (message) => failures.push(message),
      setTimeout: (callback, delay) => add(timeouts, callback, delay),
      clearTimeout: (id) => timeouts.delete(id),
      setInterval: (callback, delay) => add(intervals, callback, delay),
      clearInterval: (id) => intervals.delete(id),
    },
    setProcesses: (current) => {
      processes = current;
    },
    tick: () => {
      for (const timer of intervals.values()) timer.callback();
    },
    fireTimeout: (delay) => {
      const entry = [...timeouts].find(([, timer]) => timer.delay === delay);
      if (!entry) throw new Error(`No timeout scheduled for ${delay}`);
      timeouts.delete(entry[0]);
      elapsed += delay;
      entry[1].callback();
    },
  };
}

test("paused descendant binding freshly adopts only the pinned live root's actual descendants", () => {
  const f = fixture();
  const stop = watchElectronTestProcess(f.child, f.options);
  f.setProcesses([root, descendant, { pid: 20, ppid: 1, birth: "foreign" }]);
  deepStrictEqual(stop.bindObservedDescendant(11), descendant);
  equal(stop.bindObservedDescendant(10), undefined);
  equal(stop.bindObservedDescendant(20), undefined);
  equal(stop.bindObservedDescendant(30), undefined);
  f.setProcesses([
    { ...root, birth: "reused" },
    { ...descendant, birth: "replacement" },
  ]);
  equal(stop.bindObservedDescendant(11), undefined);
  stop();
});

test("binding never reacquires a reused descendant or a cleaning/disarmed watcher", () => {
  const f = fixture([root, descendant]);
  const stop = watchElectronTestProcess(f.child, f.options);
  f.setProcesses([root, { ...descendant, birth: "reused" }]);
  equal(stop.bindObservedDescendant(11), undefined);
  stop();
  equal(stop.bindObservedDescendant(11), undefined);
  const g = fixture([root, descendant]);
  const cleaning = watchElectronTestProcess(g.child, g.options);
  cleaning.terminate();
  equal(cleaning.bindObservedDescendant(11), undefined);
  g.fireTimeout(1000);
});

test("binding latches query failure and cannot return stale cached authority", () => {
  const f = fixture([root, descendant]);
  let fail = false;
  const stop = watchElectronTestProcess(f.child, {
    ...f.options,
    snapshotProcesses: () => {
      if (fail) throw Error("metadata unavailable");
      return [root, descendant];
    },
  });
  fail = true;
  equal(stop.bindObservedDescendant(11), undefined);
  fail = false;
  equal(stop.bindObservedDescendant(11), undefined);
  equal(f.failures.length, 1);
  stop();
});

test("immediately bound Main remains owned when runtime exits before the first interval", async () => {
  const f = fixture();
  const stop = watchElectronTestProcess(f.child, f.options);
  f.setProcesses([root, descendant]);
  deepStrictEqual(stop.bindObservedDescendant(descendant.pid), descendant);
  f.setProcesses([{ ...descendant, ppid: 1 }]);
  f.child.exitCode = 0;
  f.child.emit("exit", 0, null);
  deepStrictEqual(f.signals, [[descendant.pid, "SIGTERM"]]);
  f.fireTimeout(1000);
  const settled = await stop.completed;
  equal(settled.status, "cleaned");
  deepStrictEqual(settled.owned, [root, descendant]);
});

test("timeout signals owned descendants before root and escalates after one second", () => {
  const f = fixture();
  const stop = watchElectronTestProcess(f.child, f.options);
  f.setProcesses([
    root,
    descendant,
    { pid: 12, ppid: 11, birth: "grandchild" },
    { pid: 20, ppid: 1, birth: "unrelated" },
  ]);
  f.tick();
  f.fireTimeout(5_000);
  equal(f.failures.length, 1);
  equal(f.failures[0].includes("5000ms"), true);
  deepStrictEqual(f.signals, [
    [12, "SIGTERM"],
    [11, "SIGTERM"],
    [10, "SIGTERM"],
  ]);
  equal(f.intervals.size, 0);
  equal(f.child.listenerCount("exit"), 0);
  stop(); // A harness finally block must not cancel cleanup already in progress.
  f.fireTimeout(1_000);
  deepStrictEqual(f.signals.slice(3), [
    [12, "SIGKILL"],
    [11, "SIGKILL"],
    [10, "SIGKILL"],
  ]);
  equal(f.timeouts.size, 0);
});

test("reused root PID never authorizes a replacement or its descendants", () => {
  const f = fixture();
  watchElectronTestProcess(f.child, f.options);
  f.setProcesses([
    { ...root, birth: "replacement" },
    { pid: 11, ppid: 10, birth: "unrelated child" },
  ]);
  f.tick();
  f.fireTimeout(5_000);
  deepStrictEqual(f.signals, []);
  equal(f.timeouts.size, 0);
});

test("escalation skips reused descendant PID and cannot discover through it", () => {
  const f = fixture([root, descendant]);
  watchElectronTestProcess(f.child, f.options);
  f.fireTimeout(5_000);
  f.setProcesses([
    root,
    { ...descendant, birth: "replacement" },
    { pid: 12, ppid: 11, birth: "unrelated grandchild" },
  ]);
  f.fireTimeout(1_000);
  deepStrictEqual(f.signals, [
    [11, "SIGTERM"],
    [10, "SIGTERM"],
    [10, "SIGKILL"],
  ]);
});

test("normal completion cancels all timers without signaling a successful child", () => {
  const f = fixture();
  const stop = watchElectronTestProcess(f.child, f.options);
  f.setProcesses([]);
  f.child.exitCode = 0;
  f.child.emit("exit", 0, null);
  stop();
  equal(f.timeouts.size, 0);
  equal(f.intervals.size, 0);
  equal(f.child.listenerCount("exit"), 0);
  deepStrictEqual(f.signals, []);
  deepStrictEqual(f.failures, []);
});

test("a departed process tree does not require one native query per stale incarnation", async () => {
  const f = fixture([
    root,
    ...Array.from({ length: 200 }, (_, index) => ({
      pid: index + 100,
      ppid: root.pid,
      birth: `departed-${index}`,
    })),
  ]);
  let reads = 0;
  const snapshot = f.options.snapshotProcesses;
  const stop = watchElectronTestProcess(f.child, {
    ...f.options,
    snapshotProcesses: () => {
      reads++;
      return snapshot();
    },
  });
  f.setProcesses([]);
  f.child.exitCode = 0;
  f.child.emit("exit", 0, null);
  const receipt = await stop.completed;
  equal(receipt.status, "cleaned");
  equal(receipt.ownedCount, 201);
  equal(receipt.remainingCount, 0);
  equal(reads, 3, "Binding, cleanup discovery, and final disappearance proof only");
  deepStrictEqual(f.signals, []);
});

test("normal completion cleans only observed leftovers and their live descendants", () => {
  const f = fixture([root, descendant]);
  watchElectronTestProcess(f.child, f.options);
  f.setProcesses([
    { ...root, birth: "replacement" },
    { ...descendant, ppid: 1 },
    { pid: 12, ppid: 11, birth: "leftover grandchild" },
    { pid: 20, ppid: 10, birth: "unrelated child" },
  ]);
  f.child.exitCode = 0;
  f.child.emit("exit", 0, null);
  deepStrictEqual(f.signals, [
    [12, "SIGTERM"],
    [11, "SIGTERM"],
  ]);
  f.setProcesses([]);
  f.fireTimeout(1_000);
  equal(f.timeouts.size, 0);
  deepStrictEqual(f.failures, []);
});

test("stop disarms an active watcher idempotently without signaling live processes", () => {
  const f = fixture([root, descendant]);
  const stop = watchElectronTestProcess(f.child, f.options);
  stop();
  stop();
  equal(f.timeouts.size, 0);
  equal(f.intervals.size, 0);
  equal(f.child.listenerCount("exit"), 0);
  deepStrictEqual(f.signals, []);
});

test("terminate starts cleanup once and resolves only after fresh disappearance proof", async () => {
  const f = fixture([root, descendant]);
  const stop = watchElectronTestProcess(f.child, f.options);
  const completion = stop.terminate();
  equal(completion, stop.completed);
  equal(stop.terminate(), completion);
  deepStrictEqual(f.signals, [
    [11, "SIGTERM"],
    [10, "SIGTERM"],
  ]);
  equal(f.intervals.size, 0);
  equal(f.timeouts.size, 1, "Only the existing escalation timer remains");
  let resolved = false;
  completion.then(() => (resolved = true));
  await Promise.resolve();
  equal(resolved, false);
  stop(); // Manual disarm cannot cancel cleanup already in progress.
  f.fireTimeout(1_000);
  const receipt = await completion;
  equal(receipt.status, "cleaned");
  deepStrictEqual(receipt.remaining, []);
  deepStrictEqual(f.signals.slice(2), [
    [11, "SIGKILL"],
    [10, "SIGKILL"],
  ]);
  deepStrictEqual(f.failures, [], "An explicit termination is not a deadline failure");
  equal(f.timeouts.size, 0);
  equal(stop.terminate(), completion);
  equal(f.signals.length, 4);
});

test("terminate rechecks identity before each signal and skips PID replacements", async () => {
  const f = fixture([root, descendant]);
  let reads = 0;
  const stop = watchElectronTestProcess(f.child, {
    ...f.options,
    snapshotProcesses() {
      reads++;
      // Both the initial binding and cleanup discovery see the originals.
      // The individual-signal snapshot sees only new incarnations.
      return reads < 3
        ? [root, descendant]
        : [
            { ...root, birth: "replacement root" },
            { ...descendant, birth: "replacement descendant" },
            { pid: 12, ppid: 11, birth: "unrelated grandchild" },
          ];
    },
  });
  const receipt = await stop.terminate();
  equal(receipt.status, "cleaned");
  equal(receipt.ownedCount, 2);
  equal(reads >= 5, true);
  deepStrictEqual(f.signals, []);
  deepStrictEqual(f.failures, []);
  equal(f.timeouts.size, 0);
});

test("terminate cannot regain authority after a manual disarm", async () => {
  const f = fixture([root, descendant]);
  let reads = 0;
  const stop = watchElectronTestProcess(f.child, {
    ...f.options,
    snapshotProcesses() {
      reads++;
      return [root, descendant];
    },
  });
  stop();
  const receipt = await stop.terminate();
  equal(receipt.status, "disarmed");
  equal(reads, 1, "A disarmed watcher must not query or rediscover processes");
  deepStrictEqual(f.signals, []);
  equal(f.timeouts.size, 0);
  equal(f.intervals.size, 0);
});

test("terminate fails closed after a query failure even if a later query could recover", async () => {
  const f = fixture();
  let reads = 0;
  const stop = watchElectronTestProcess(f.child, {
    ...f.options,
    snapshotProcesses() {
      if (++reads === 2) throw new Error("fixed query failure");
      return [root];
    },
  });
  const receipt = await stop.terminate();
  equal(receipt.status, "unproven");
  equal(receipt.queryFailed, true);
  equal(receipt.remaining, null);
  equal(reads, 2, "Failed identity observation cannot be retried into signaling authority");
  deepStrictEqual(f.signals, []);
  equal(f.failures.length, 1);
  equal(stop.terminate(), stop.completed);
  equal(reads, 2);
  equal(f.timeouts.size, 0);
});

test("already exited children expose terminate without acquiring identity or authority", async () => {
  const f = fixture();
  f.child.exitCode = 0;
  const stop = watchElectronTestProcess(f.child, {
    ...f.options,
    snapshotProcesses() {
      throw new Error("An exited child must not be queried");
    },
  });
  equal(stop.terminate(), stop.completed);
  equal((await stop.terminate()).status, "unproven");
  deepStrictEqual(f.signals, []);
  equal(f.timeouts.size, 0);
});

test("completion waits for fresh proof after escalation instead of equating a signal with exit", async () => {
  const f = fixture([root, descendant]);
  const stop = watchElectronTestProcess(f.child, {
    ...f.options,
    signalProcess: (pid, signal) => f.signals.push([pid, signal]),
  });
  let resolved = false;
  stop.completed.then(() => (resolved = true));
  f.fireTimeout(5_000);
  stop();
  f.fireTimeout(1_000);
  await Promise.resolve();
  equal(resolved, false);
  equal(f.timeouts.size, 1);
  f.setProcesses([]);
  f.fireTimeout(100);
  const receipt = await stop.completed;
  equal(receipt.status, "cleaned");
  equal(receipt.ownedCount, 2);
  deepStrictEqual(receipt.remaining, []);
  equal(receipt.queryFailed, false);
});

test("residual original processes resolve unproven with bounded evidence", async () => {
  const f = fixture([root]);
  const stop = watchElectronTestProcess(f.child, {
    ...f.options,
    signalProcess: (pid, signal) => f.signals.push([pid, signal]),
  });
  f.fireTimeout(5_000);
  f.fireTimeout(1_000);
  for (let count = 0; count < 30; count++) f.fireTimeout(100);
  const receipt = await stop.completed;
  equal(receipt.status, "unproven");
  deepStrictEqual(receipt.remaining, [root]);
  equal(receipt.remainingCount, 1);
  equal(f.failures.length, 2);
  equal(f.timeouts.size, 0);
});

test("query failure resolves unproven and manual disarm never claims process exit", async () => {
  const f = fixture();
  let reads = 0;
  const stop = watchElectronTestProcess(f.child, {
    ...f.options,
    snapshotProcesses() {
      if (reads++ === 0) return [root];
      throw new Error("query failed");
    },
  });
  f.fireTimeout(5_000);
  const failed = await stop.completed;
  equal(failed.status, "unproven");
  equal(failed.queryFailed, true);
  equal(failed.remaining, null);
  deepStrictEqual(f.signals, []);
  const manual = fixture();
  const disarm = watchElectronTestProcess(manual.child, manual.options);
  disarm();
  equal((await disarm.completed).status, "disarmed");
});

test("receipt evidence is bounded without truncating the tracked cleanup proof", async () => {
  const children = Array.from({ length: 600 }, (_, index) => ({
    pid: 1_000 + index,
    ppid: root.pid,
    birth: `child-${index}`,
  }));
  const f = fixture([root, ...children]);
  const stop = watchElectronTestProcess(f.child, f.options);
  f.setProcesses([]);
  f.child.exitCode = 0;
  f.child.emit("exit", 0, null);
  const receipt = await stop.completed;
  equal(receipt.status, "cleaned");
  equal(receipt.ownedCount, 601);
  equal(receipt.owned.length, 512);
  equal(receipt.evidenceTruncated, true);
  equal(receipt.remainingCount, 0);
});

test("actual native owned child cleanup settles only after fresh identity disappearance", async () => {
  // The child has its own fallback exit so a failed identity query cannot leak it.
  const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 5000)"], {
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const failures = [];
  try {
    const stop = watchElectronTestProcess(child, {
      timeoutMs: 200,
      reportFailure: (message) => failures.push(message),
    });
    const receipt = await stop.completed;
    equal(receipt.status, "cleaned");
    equal(
      receipt.owned.some((row) => row.pid === child.pid && row.ppid === process.pid),
      true,
    );
    deepStrictEqual(receipt.remaining, []);
    equal(failures.length, 1, "Only the deliberate test deadline reports a failure");
  } finally {
    await exited;
  }
});

test("invalid timeout is rejected before snapshots or timers", () => {
  for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, "5000", 2_147_483_648]) {
    const f = fixture();
    throws(() => watchElectronTestProcess(f.child, { ...f.options, timeoutMs }), /timeoutMs/);
    equal(f.timeouts.size, 0);
    equal(f.intervals.size, 0);
  }
});

test("custody requires the actual child PID and parent PID at initialization", () => {
  const f = fixture([{ ...root, ppid: 1 }]);
  throws(() => watchElectronTestProcess(f.child, f.options), /birth identity/);
  equal(f.timeouts.size, 0);
  deepStrictEqual(f.signals, []);
});

test("snapshot failure skips signaling rather than relying on an old snapshot", () => {
  const f = fixture([root, descendant]);
  let reads = 0;
  watchElectronTestProcess(f.child, {
    ...f.options,
    snapshotProcesses: () => {
      if (reads++ === 0) return [root, descendant];
      throw new Error("ps timed out");
    },
  });
  f.tick();
  f.tick();
  f.fireTimeout(5_000);
  deepStrictEqual(f.signals, []);
  equal(f.failures.length, 2); // One snapshot failure and the independent test deadline.
  equal(f.timeouts.size, 0);
});

for (const platform of ["linux", "win32"])
  test(`${platform} enables bounded ownership cleanup instead of returning a no-op`, () => {
    const f = fixture([root, descendant]);
    watchElectronTestProcess(f.child, { ...f.options, platform });
    equal(f.timeouts.size, 1);
    equal(f.intervals.size, 1);
    f.fireTimeout(5_000);
    deepStrictEqual(f.signals, [
      [11, "SIGTERM"],
      [10, "SIGTERM"],
    ]);
    f.setProcesses([
      { ...root, birth: "replacement" },
      { ...descendant, birth: "replacement" },
    ]);
    f.fireTimeout(1_000);
    equal(f.signals.length, 2);
  });

test("each signal rechecks identity after the preceding signal can race PID reuse", () => {
  const f = fixture([root, descendant]);
  watchElectronTestProcess(f.child, {
    ...f.options,
    signalProcess: (pid, signal) => {
      f.signals.push([pid, signal]);
      f.setProcesses([{ ...root, birth: "replacement" }, descendant]);
    },
  });
  f.fireTimeout(5_000);
  deepStrictEqual(f.signals, [[11, "SIGTERM"]]);
});

for (const platform of ["darwin", "linux", "win32"])
  test(`${platform} query failure cannot fall back to a stale identity or authorize any signal`, () => {
    const initialFailure = fixture();
    throws(
      () =>
        watchElectronTestProcess(initialFailure.child, {
          ...initialFailure.options,
          platform,
          snapshotProcesses() {
            throw new Error("metadata query timed out");
          },
        }),
      /Cannot establish/,
    );
    equal(initialFailure.timeouts.size, 0);
    deepStrictEqual(initialFailure.signals, []);
    const laterFailure = fixture([root, descendant]);
    let reads = 0;
    watchElectronTestProcess(laterFailure.child, {
      ...laterFailure.options,
      platform,
      snapshotProcesses() {
        if (reads++ === 0) return [root, descendant];
        throw new Error("metadata query timed out");
      },
    });
    laterFailure.fireTimeout(5_000);
    deepStrictEqual(laterFailure.signals, []);
    equal(laterFailure.failures.length, 2);
    equal(laterFailure.timeouts.size, 0);
  });

test("unsupported platforms fail closed and already-exited children require no snapshot", () => {
  const unsupported = fixture([]);
  throws(
    () =>
      watchElectronTestProcess(unsupported.child, { ...unsupported.options, platform: "freebsd" }),
    /Unsupported/,
  );
  const f = fixture([]);
  f.child.exitCode = 0;
  watchElectronTestProcess(f.child, f.options)();
  equal(f.timeouts.size, 0);
});

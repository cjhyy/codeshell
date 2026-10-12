import { deepStrictEqual, equal, throws } from "node:assert/strict";
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
      signalProcess: (pid, signal) => signals.push([pid, signal]),
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
      entry[1].callback();
    },
  };
}

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

test("other platforms and already-exited children do not inspect macOS processes", () => {
  for (const change of [{ platform: "linux" }, { platform: "win32" }]) {
    const f = fixture([]);
    watchElectronTestProcess(f.child, { ...f.options, ...change })();
    equal(f.timeouts.size, 0);
  }
  const f = fixture([]);
  f.child.exitCode = 0;
  watchElectronTestProcess(f.child, f.options)();
  equal(f.timeouts.size, 0);
});

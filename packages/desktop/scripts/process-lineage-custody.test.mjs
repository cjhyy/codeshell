import { deepStrictEqual, equal, throws } from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { after, test } from "node:test";
import tls from "node:tls";

// This single explicitly named Node file is pure. Install guards before either
// production module imports the native snapshot transport. No real process
// query, process creation, signal, network request or real timer is permitted.
const forbidden = [];
const deny = (name) => () => {
  forbidden.push(name);
  throw new Error(`Pure lineage test denied ${name}`);
};
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
  childProcess[name] = deny(`child_process.${name}`);
process.kill = deny("process.kill");
globalThis.fetch = deny("fetch");
http.request = deny("http.request");
http.get = deny("http.get");
https.request = deny("https.request");
https.get = deny("https.get");
net.connect = deny("net.connect");
net.createConnection = deny("net.createConnection");
tls.connect = deny("tls.connect");
syncBuiltinESMExports();
const { rememberOwnedProcesses } = await import("./process-custody.mjs");
const { watchElectronTestProcess } = await import("./electron-test-watchdog.mjs");
after(() => deepStrictEqual(forbidden, [], "No real OS query, child, signal or network attempted"));

const posix = (second) => `Sat Oct 17 13:40:${String(second).padStart(2, "0")} 2026`;
const root = { pid: 10, ppid: 99, birth: posix(0) };
const child = { pid: 11, ppid: 10, birth: posix(1) };
const grandchild = { pid: 12, ppid: 11, birth: posix(2) };
const winRoot = { pid: 3188, ppid: 2356, birth: "2026-10-17T13:46:56.2948840Z" };
const winChild = { pid: 2520, ppid: 4512, birth: "2026-10-17T13:47:27.6162490Z" };
const olderForeign = { pid: 976, ppid: 2520, birth: "2026-10-17T13:41:23.3361640Z" };
const winChain = [
  winRoot,
  { pid: 5136, ppid: 3188, birth: "2026-10-17T13:47:26.7472560Z" },
  { pid: 5968, ppid: 5136, birth: "2026-10-17T13:47:26.8281970Z" },
  { pid: 4512, ppid: 5968, birth: "2026-10-17T13:47:27.6041920Z" },
  winChild,
];

function fixture(initial = [root], platform = "darwin") {
  const fakeChild = Object.assign(new EventEmitter(), {
    pid: initial[0].pid,
    exitCode: null,
    signalCode: null,
  });
  let rows = initial;
  let elapsed = 0;
  let timerId = 0;
  const timeouts = new Map();
  const intervals = new Map();
  const signals = [];
  const failures = [];
  const add = (timers, callback, delay) => {
    const id = ++timerId;
    timers.set(id, { callback, delay });
    return id;
  };
  const options = {
    platform,
    parentPid: initial[0].ppid,
    timeoutMs: 5000,
    snapshotProcesses: () => rows,
    signalProcess: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === "SIGKILL") rows = rows.filter((row) => row.pid !== pid);
    },
    reportFailure: (message) => failures.push(message),
    now: () => elapsed,
    setTimeout: (callback, delay) => add(timeouts, callback, delay),
    clearTimeout: (id) => timeouts.delete(id),
    setInterval: (callback, delay) => add(intervals, callback, delay),
    clearInterval: (id) => intervals.delete(id),
  };
  return {
    fakeChild,
    options,
    signals,
    failures,
    timeouts,
    intervals,
    setRows: (value) => (rows = value),
    tick: () => [...intervals.values()].forEach((timer) => timer.callback()),
    fire: (delay) => {
      const entry = [...timeouts].find(([, timer]) => timer.delay === delay);
      if (!entry) throw Error(`No mock timer ${delay}`);
      timeouts.delete(entry[0]);
      elapsed += delay;
      entry[1].callback();
    },
  };
}

test("CI Windows older foreign PID is not adopted through a newer live child", () => {
  const owned = new Map([[winRoot.pid, winRoot]]);
  rememberOwnedProcesses(owned, [olderForeign, ...winChain.toReversed()]);
  deepStrictEqual([...owned.values()], winChain);
});

test("actual watchdog never delegates a signal for the older Windows foreign PID", async () => {
  const f = fixture([...winChain, olderForeign], "win32");
  const stop = watchElectronTestProcess(f.fakeChild, f.options);
  stop.terminate();
  deepStrictEqual(
    f.signals,
    winChain.toReversed().map((row) => [row.pid, "SIGTERM"]),
  );
  f.fire(1000);
  const receipt = await stop.completed;
  equal(receipt.status, "cleaned");
  deepStrictEqual(receipt.owned, winChain);
  equal(
    f.signals.some(([pid]) => pid === 976),
    false,
  );
});

test("full Windows precision rejects an older hundred-nanosecond sibling and permits equal birth", () => {
  const parent = { pid: 10, ppid: 1, birth: "2026-10-17T13:47:27.6162490Z" };
  const older = { pid: 11, ppid: 10, birth: "2026-10-17T13:47:27.6162489Z" };
  const same = { pid: 12, ppid: 10, birth: parent.birth };
  const later = { pid: 13, ppid: 12, birth: "2026-10-17T13:47:27.6162491Z" };
  const owned = new Map([[10, parent]]);
  rememberOwnedProcesses(owned, [later, older, same, parent]);
  deepStrictEqual([...owned.values()], [parent, same, later]);
});

test("POSIX equal-second children remain authorized across unsorted multi-depth snapshots", () => {
  const same = { ...child, birth: root.birth };
  const owned = new Map([[10, root]]);
  rememberOwnedProcesses(owned, [grandchild, same, root]);
  deepStrictEqual([...owned.values()], [root, same, grandchild]);
});

test("POSIX chronology orders calendar components rather than weekday/month text", () => {
  const parent = { pid: 10, ppid: 1, birth: "Sun Mar  1 00:00:00 2026" };
  const older = { pid: 11, ppid: 10, birth: "Sat Feb 28 23:59:59 2026" };
  const same = { pid: 12, ppid: 10, birth: parent.birth };
  const owned = new Map([[10, parent]]);
  rememberOwnedProcesses(owned, [older, same, parent]);
  deepStrictEqual([...owned.values()], [parent, same]);
});

test("existing full-birth root reuse guard cannot authorize the replacement's children", () => {
  const owned = new Map([[10, root]]);
  rememberOwnedProcesses(owned, [{ ...root, birth: posix(10) }, child, grandchild]);
  deepStrictEqual([...owned.values()], [root]);
});

test("existing full-birth descendant reuse guard cannot overwrite custody or expand", () => {
  const owned = new Map([
    [10, root],
    [11, child],
  ]);
  rememberOwnedProcesses(owned, [root, { ...child, birth: posix(10) }, grandchild]);
  deepStrictEqual([...owned.values()], [root, child]);
});

test("already owned reparented orphan remains tracked and can authorize its later child", () => {
  const owned = new Map([
    [10, root],
    [11, child],
  ]);
  rememberOwnedProcesses(owned, [{ ...root, birth: posix(10) }, { ...child, ppid: 1 }, grandchild]);
  deepStrictEqual([...owned.values()], [root, child, grandchild]);
});

test("absent parent cannot authorize an unobserved child through a cached PID", () => {
  const owned = new Map([
    [10, root],
    [11, child],
  ]);
  rememberOwnedProcesses(owned, [grandchild]);
  deepStrictEqual([...owned.values()], [root, child]);
});

for (const invalid of [
  "2026-02-30T13:47:27.6162490Z",
  "2026-10-17T25:47:27.6162490Z",
  "2026-10-17T13:47:27.616Z",
  "2026-10-17T13:47:27.6162490+00:00",
  "Fri Feb 30 13:47:27 2026",
  "Sat Oct 17 13:60:27 2026",
  "Sun Oct 17 13:47:27 2026",
  "root",
  null,
  undefined,
])
  test(`malformed complete birth fails atomically: ${String(invalid)}`, () => {
    const owned = new Map([[winRoot.pid, winRoot]]);
    throws(
      () =>
        rememberOwnedProcesses(owned, [winRoot, winChild, { pid: 77, ppid: 2520, birth: invalid }]),
      /birth|metadata/,
    );
    deepStrictEqual([...owned.values()], [winRoot]);
  });

test("duplicate PID and mixed platform clocks reject the whole snapshot before adoption", () => {
  for (const rows of [
    [winRoot, winChild, { ...winChild, birth: "2026-10-17T13:48:00.0000000Z" }],
    [winRoot, { ...winChild, birth: posix(1) }],
  ]) {
    const owned = new Map([[winRoot.pid, winRoot]]);
    throws(() => rememberOwnedProcesses(owned, rows), /birth|metadata/);
    deepStrictEqual([...owned.values()], [winRoot]);
  }
});

test("malformed initial root cannot create a watcher, timer or signal authority", () => {
  const f = fixture([{ ...root, birth: "malformed" }]);
  throws(() => watchElectronTestProcess(f.fakeChild, f.options), /birth|metadata/);
  equal(f.timeouts.size + f.intervals.size, 0);
  deepStrictEqual(f.signals, []);
});

test("malformed later observation latches unproven even when later metadata recovers", async () => {
  const f = fixture([root, child]);
  const stop = watchElectronTestProcess(f.fakeChild, f.options);
  f.setRows([root, child, { pid: 12, ppid: 11, birth: "malformed" }]);
  f.tick();
  f.setRows([root, child]);
  const completed = stop.terminate();
  deepStrictEqual(f.signals, []);
  const receipt = await completed;
  equal(receipt.status, "unproven");
  equal(receipt.queryFailed, true);
  equal(f.failures.length, 1);
});

test("normal exit still requires fresh disappearance and sends no signal spy", async () => {
  const f = fixture([root, child]);
  const stop = watchElectronTestProcess(f.fakeChild, f.options);
  f.setRows([]);
  f.fakeChild.exitCode = 0;
  f.fakeChild.emit("exit", 0, null);
  const receipt = await stop.completed;
  equal(receipt.status, "cleaned");
  equal(receipt.ownedCount, 2);
  deepStrictEqual(receipt.remaining, []);
  deepStrictEqual(f.signals, []);
  equal(f.timeouts.size + f.intervals.size, 0);
});

test("bounded completion evidence never truncates the internally owned 600-child proof", async () => {
  const children = Array.from({ length: 600 }, (_, index) => ({
    pid: 1000 + index,
    ppid: 10,
    birth: posix(1),
  }));
  const f = fixture([root, ...children]);
  const stop = watchElectronTestProcess(f.fakeChild, f.options);
  f.setRows([]);
  f.fakeChild.exitCode = 0;
  f.fakeChild.emit("exit", 0, null);
  const receipt = await stop.completed;
  equal(receipt.status, "cleaned");
  equal(receipt.ownedCount, 601);
  equal(receipt.owned.length, 512);
  equal(receipt.evidenceTruncated, true);
  equal(receipt.remainingCount, 0);
});

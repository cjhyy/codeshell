/** Inert transport and fake scheduler only. This file never queries or signals an OS process. */
import assert from "node:assert/strict";
import * as children from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { test } from "node:test";

const native = createRequire(import.meta.url)("node:child_process");
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  native[name] = () => {
    throw Error(`Native transport denied: ${name}`);
  };
}
process.kill = () => {
  throw Error("Native signal denied");
};
syncBuiltinESMExports();
const { snapshotElectronTestProcesses, parseWindowsProcessSnapshot } =
  await import("./electron-test-process-snapshot.mjs");
const { watchElectronTestProcess } = await import("./electron-test-watchdog.mjs");
const { createNsisReplacementRoleObserver, nsisReplacementRolesQuery } =
  await import("./windows-nsis-process-roles.mjs");

const birth = (fraction) => `2026-10-18T01:02:03.${String(fraction).padStart(7, "0")}Z`;
const rootProcess = { pid: 42, ppid: 99, birth: birth(1) };
const oldProcess = { pid: 43, ppid: 42, birth: birth(2) };
const identities = (rows) =>
  rows.map(({ pid, ppid, birth }) => ({
    ProcessId: pid,
    ParentProcessId: ppid,
    CreationDate: birth,
  }));
const hints = {
  root: "D:\\owned\\nsis",
  setup: "D:\\owned\\nsis\\artifacts\\Setup.exe",
  uninstaller: "D:\\owned\\nsis\\CodeShell\\Uninstall.exe",
  temporary: "D:\\owned\\nsis\\private-build\\tmp",
  environment: { SystemRoot: "C:\\Windows" },
};
function roleFixture(rows = [rootProcess, oldProcess], roles = []) {
  const calls = [];
  let elapsed = 0;
  let envelope = { processes: identities(rows), roles, truncated: false };
  const observer = createNsisReplacementRoleObserver({
    ...hints,
    now: () => elapsed,
    execFile: (...args) => {
      calls.push(args);
      elapsed += 2;
      return JSON.stringify(envelope);
    },
  });
  return {
    observer,
    calls,
    setEnvelope: (next) => {
      envelope = next;
    },
    advance: (value) => {
      elapsed += value;
    },
  };
}
const observed = (observer, rows, phase = "initial") =>
  observer.onOwnedSnapshot({ phase, ownedCurrent: rows });

test("all native transports are denied before importing the actual leaves", () => {
  assert.throws(() => children.execFileSync("not-run"), /Native transport denied/);
  assert.throws(() => process.kill(42, "SIGTERM"), /Native signal denied/);
});

test("default Windows query retains its exact three fields, no sidecar and original command budget", () => {
  let call;
  const result = snapshotElectronTestProcesses({
    platform: "win32",
    environment: hints.environment,
    execFile: (...args) => {
      call = args;
      return JSON.stringify(identities([rootProcess]));
    },
  });
  assert.deepEqual(result, [rootProcess]);
  assert.equal(call[0], "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  assert.deepEqual(call[1].slice(0, -1), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
  assert.match(call[1].at(-1), /-Property ProcessId,ParentProcessId,CreationDate \|/);
  assert.doesNotMatch(call[1].at(-1), /ExecutablePath|Console\]::In|roles/);
  assert.deepEqual(call[2], {
    env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", PATH: "C:\\Windows\\System32" },
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.throws(() =>
    parseWindowsProcessSnapshot(
      JSON.stringify([{ ...identities([rootProcess])[0], role: "setup-path-match" }]),
    ),
  );
});

test("opt-in performs one original-budget call and sends only finite owned hints through stdin", () => {
  const f = roleFixture([rootProcess], [{ ...rootProcess, role: "setup-path-match" }]);
  assert.deepEqual(f.observer.snapshot(), [rootProcess]);
  observed(f.observer, [rootProcess]);
  assert.equal(f.calls.length, 1);
  const [executable, args, options] = f.calls[0];
  assert.equal(executable, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  assert.equal(args.at(-1), nsisReplacementRolesQuery);
  assert.deepEqual(args.slice(0, -1), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
  assert.equal(options.timeout, 5000);
  assert.equal(options.maxBuffer, 8 * 1024 * 1024);
  assert.deepEqual(options.env, {
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    PATH: "C:\\Windows\\System32",
  });
  assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
  assert.deepEqual(JSON.parse(options.input), {
    setup: hints.setup,
    uninstaller: hints.uninstaller,
    temporary: hints.temporary,
  });
  assert.equal(f.observer.receipt.samples[0].rows[0].role, "setup-path-match");
  assert.doesNotMatch(JSON.stringify(f.observer.receipt), /D:|Setup\.exe|Uninstall\.exe/);
});

test("foreign and changed parent or seven-fraction birth metadata cannot label an owned identity", () => {
  const f = roleFixture(
    [rootProcess, oldProcess],
    [
      { ...rootProcess, ppid: 1, role: "setup-path-match" },
      { ...oldProcess, birth: birth(3), role: "owned-temp-old-uninstaller-candidate" },
      { pid: 800, ppid: 1, birth: birth(1), role: "installed-uninstaller-path-match" },
    ],
  );
  f.observer.snapshot();
  observed(f.observer, [rootProcess, oldProcess]);
  assert.deepEqual(
    f.observer.receipt.samples[0].rows.map((row) => row.role),
    ["unknown", "unknown"],
  );
});

test("unknown, null, path aliases, foreign TEMP and root-only hints stay unknown without extra calls", () => {
  for (const override of [
    { setup: null },
    { setup: "D:\\owned\\nsis\\artifacts\\..\\Setup.exe" },
    { setup: "D:\\OWNED~1\\nsis\\Setup.exe" },
    { temporary: "C:\\Windows\\Temp" },
    { root: "D:\\" },
    { temporary: hints.temporary + "\\" },
    { uninstaller: "D:/owned/nsis/Uninstall.exe" },
  ]) {
    let calls = 0;
    const observer = createNsisReplacementRoleObserver({
      ...hints,
      ...override,
      execFile: () => {
        calls++;
        return JSON.stringify({
          processes: identities([rootProcess]),
          roles: [{ ...rootProcess, role: "setup-path-match" }],
          truncated: false,
        });
      },
      now: () => 0,
    });
    assert.deepEqual(observer.snapshot(), [rootProcess]);
    observed(observer, [rootProcess]);
    assert.equal(calls, 1);
    assert.equal(observer.receipt.samples[0].rows[0].role, "unknown");
  }
});

test("malformed sidecars degrade to unknown while malformed authority still fails closed", () => {
  const f = roleFixture([rootProcess], [{ ...rootProcess, role: "not-an-enum", path: "private" }]);
  assert.deepEqual(f.observer.snapshot(), [rootProcess]);
  observed(f.observer, [rootProcess]);
  assert.equal(f.observer.receipt.observerFault, true);
  assert.equal(f.observer.receipt.samples[0].rows[0].role, "unknown");
  f.setEnvelope({
    processes: [{ ...identities([rootProcess])[0], birth: "extra" }],
    roles: [],
    truncated: false,
  });
  assert.throws(() => f.observer.snapshot());
});

test("a consumed or failed query cannot replay an older role sidecar", () => {
  const f = roleFixture([rootProcess], [{ ...rootProcess, role: "setup-path-match" }]);
  f.observer.snapshot();
  observed(f.observer, [rootProcess]);
  observed(f.observer, [rootProcess]);
  assert.equal(f.observer.receipt.sampleCount, 1);
  assert.equal(f.observer.receipt.observerFault, true);
  f.setEnvelope({ processes: identities([rootProcess]), roles: [], truncated: false });
  f.observer.snapshot();
  observed(f.observer, [rootProcess], "cleaning");
  assert.equal(f.observer.receipt.samples.at(-1).rows[0].role, "unknown");
});

test("public samples are finite and retain explicit truncation and last-query age", () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({
    pid: index + 100,
    ppid: 42,
    birth: birth(2),
  }));
  const f = roleFixture(rows);
  for (let i = 0; i < 12; i++) {
    f.observer.snapshot();
    observed(f.observer, rows, "watching");
  }
  f.advance(13);
  f.observer.markFailure();
  f.advance(5);
  f.observer.markFailure();
  const result = f.observer.receipt;
  assert.equal(result.samples.length, 8);
  assert.equal(result.sampleCount, 12);
  assert.equal(result.samplesTruncated, true);
  assert.equal(result.samples[0].rows.length, 32);
  assert.equal(result.samples[0].rolesTruncated, true);
  assert.equal(result.failureObservation.sampleAgeMs, 13);
  assert.match(result.failureObservation.boundary, /not an atomic deadline snapshot/);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 64 * 1024);
});

function watchdogFixture(useObserver = true, throwObserver = false) {
  const child = Object.assign(new EventEmitter(), { pid: 42, exitCode: null, signalCode: null });
  const timeouts = new Map(),
    intervals = new Map(),
    signals = [],
    events = [];
  let elapsed = 0,
    nextTimer = 1,
    processes = [rootProcess, oldProcess],
    queryCount = 0;
  const f = roleFixture(processes, [
    { ...rootProcess, role: "setup-path-match" },
    { ...oldProcess, role: "owned-temp-old-uninstaller-candidate" },
  ]);
  const timer = (map, callback, delay) => {
    const id = nextTimer++;
    map.set(id, { callback, delay });
    return id;
  };
  const query = () => {
    queryCount++;
    f.setEnvelope({
      processes: identities(processes),
      roles: processes.map((row) => ({
        ...row,
        role: row.pid === 42 ? "setup-path-match" : "owned-temp-old-uninstaller-candidate",
      })),
      truncated: false,
    });
    return f.observer.snapshot();
  };
  const monitor = watchElectronTestProcess(child, {
    platform: "win32",
    parentPid: 99,
    timeoutMs: 180000,
    snapshotProcesses: query,
    signalProcess: (pid, signal) => {
      signals.push([pid, signal]);
      events.push("signal");
      if (signal === "SIGKILL") processes = processes.filter((row) => row.pid !== pid);
    },
    reportFailure: () => {
      events.push("original-failure");
      f.observer.markFailure();
    },
    now: () => elapsed,
    setTimeout: (callback, delay) => timer(timeouts, callback, delay),
    clearTimeout: (id) => timeouts.delete(id),
    setInterval: (callback, delay) => timer(intervals, callback, delay),
    clearInterval: (id) => intervals.delete(id),
    ...(useObserver
      ? {
          onOwnedSnapshot: (sample) => {
            if (throwObserver) {
              sample.ownedCurrent[0].pid = 999;
              throw Error("observer fault");
            }
            f.observer.onOwnedSnapshot(sample);
          },
        }
      : {}),
  });
  const fire = (delay) => {
    const entry = [...timeouts].find(([, value]) => value.delay === delay);
    assert.ok(entry);
    timeouts.delete(entry[0]);
    elapsed += delay;
    entry[1].callback();
  };
  return {
    f,
    monitor,
    child,
    signals,
    events,
    fire,
    queryCount: () => queryCount,
    processes: (rows) => {
      processes = rows;
    },
    tick: () => {
      for (const item of intervals.values()) item.callback();
    },
    timeouts,
    intervals,
  };
}

test("actual custody filters earlier births and foreign processes before advisory publication", () => {
  const f = watchdogFixture();
  f.processes([
    rootProcess,
    oldProcess,
    { pid: 44, ppid: 42, birth: birth(0) },
    { pid: 45, ppid: 1, birth: birth(4) },
  ]);
  f.tick();
  assert.deepEqual(
    f.f.observer.receipt.samples.at(-1).rows.map((row) => row.pid),
    [42, 43],
  );
  f.monitor();
});

test("original timeout is first; role callbacks add no query, timer, signal, or cleanup authority", async () => {
  const enabled = watchdogFixture(),
    disabled = watchdogFixture(false),
    throwing = watchdogFixture(true, true);
  for (const f of [enabled, disabled, throwing]) {
    f.fire(180000);
    f.fire(1000);
  }
  const settlements = await Promise.all([
    enabled.monitor.completed,
    disabled.monitor.completed,
    throwing.monitor.completed,
  ]);
  assert.deepEqual(settlements[0], settlements[1]);
  assert.deepEqual(settlements[0], settlements[2]);
  assert.equal(settlements[0].status, "cleaned");
  assert.deepEqual(settlements[0].remaining, []);
  for (const f of [enabled, disabled, throwing]) {
    assert.equal(f.events[0], "original-failure");
    assert.deepEqual(f.signals, [
      [43, "SIGTERM"],
      [42, "SIGTERM"],
      [43, "SIGKILL"],
      [42, "SIGKILL"],
    ]);
    assert.equal(f.queryCount(), enabled.queryCount());
    assert.equal(f.timeouts.size, 0);
    assert.equal(f.intervals.size, 0);
  }
  assert.ok(enabled.f.observer.receipt.samples.some((row) => row.samplePhase === "cleaning"));
  assert.equal(throwing.f.observer.receipt.sampleCount, 0);
});

test("normal Main exit retains descendant-only cleanup and unknown faults cannot change it", async () => {
  const f = watchdogFixture();
  f.processes([oldProcess]);
  f.child.exitCode = 0;
  f.child.emit("exit", 0, null);
  f.fire(1000);
  assert.deepEqual(f.signals, [
    [43, "SIGTERM"],
    [43, "SIGKILL"],
  ]);
  assert.equal((await f.monitor.completed).status, "cleaned");
  assert.equal(f.child.exitCode, 0);
  assert.equal(f.child.signalCode, null);
});

// The injected-clock fixtures above must not hide a broken real default receiver.
test("real default clock yields finite role sample and failure age without a native query", () => {
  console.log(
    JSON.stringify({
      kind: "default-clock-runtime",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    }),
  );
  const calls = [];
  // Deliberately omit now: use the actual module default, with only execFile inert.
  const observer = createNsisReplacementRoleObserver({
    ...hints,
    execFile: (...args) => {
      calls.push(args);
      return JSON.stringify({
        processes: identities([rootProcess]),
        roles: [{ ...rootProcess, role: "setup-path-match" }],
        truncated: false,
      });
    },
  });
  assert.equal(observer.receipt.observerFault, false, "Real default clock must initialize");
  const current = observer.snapshot();
  observed(observer, current);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  assert.equal(calls[0][2].timeout, 5000);
  assert.deepEqual(current, [rootProcess]);
  assert.equal(observer.receipt.observerFault, false);
  assert.equal(observer.receipt.sampleCount, 1);
  const sample = observer.receipt.samples[0];
  assert.equal(Number.isFinite(sample.sampledElapsedMs), true);
  assert.ok(sample.sampledElapsedMs >= 0);
  assert.deepEqual(sample.rows, [{ ...rootProcess, role: "setup-path-match" }]);
  observer.markFailure();
  const failure = observer.receipt.failureObservation;
  assert.equal(failure.sampleQuerySequence, sample.querySequence);
  assert.equal(failure.samplePhase, "initial");
  assert.equal(Number.isFinite(failure.sampleAgeMs), true);
  assert.ok(failure.sampleAgeMs >= 0);
  assert.equal(observer.receipt.observerFault, false);
});

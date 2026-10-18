import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import tls from "node:tls";

// The explicit shard uses only fake process metadata, events, timers and log IO.
// Install all transport guards before importing the actual watchdog closure.
const forbidden = [];
const deny = (name) => () => {
  forbidden.push(name);
  throw new Error(`Pure initial identity test denied ${name}`);
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
const { watchElectronTestProcess } = await import("./electron-test-watchdog.mjs");
after(() => assert.deepEqual(forbidden, [], "No real transport, query or signal attempted"));

const birth = "2026-10-18T03:01:19.3294400Z";
const missingIdentity = "Cannot establish Electron test child PID, parent PID and birth identity";
const boundary =
  "Same initial snapshot rows only; diagnostic projection, not custody authority or process liveness.";

function fixture(initial = []) {
  const child = Object.assign(new EventEmitter(), {
    pid: 42,
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    unref() {
      this.unreferenced = true;
    },
  });
  let rows = initial;
  let queries = 0;
  let timerId = 0;
  const timeouts = new Map();
  const intervals = new Map();
  const signals = [];
  const failures = [];
  const observations = [];
  const add = (timers, callback, delay) => {
    const id = ++timerId;
    timers.set(id, { callback, delay });
    return id;
  };
  const options = {
    platform: "win32",
    parentPid: 99,
    timeoutMs: 180_000,
    snapshotProcesses: () => {
      queries++;
      return rows;
    },
    signalProcess: (pid, signal) => signals.push([pid, signal]),
    reportFailure: (message) => failures.push(message),
    now: () => 0,
    setTimeout: (callback, delay) => add(timeouts, callback, delay),
    clearTimeout: (id) => timeouts.delete(id),
    setInterval: (callback, delay) => add(intervals, callback, delay),
    clearInterval: (id) => intervals.delete(id),
    onInitialIdentityFailure: (value) => observations.push(value),
  };
  return {
    child,
    options,
    observations,
    signals,
    failures,
    timeouts,
    intervals,
    queries: () => queries,
    setRows: (value) => (rows = value),
  };
}

function rejectWithoutAuthority(value) {
  assert.throws(() => watchElectronTestProcess(value.child, value.options), {
    name: "Error",
    message: missingIdentity,
  });
  assert.equal(value.queries(), 1, "No additional identity query or retry");
  assert.equal(value.timeouts.size + value.intervals.size, 0);
  assert.equal(value.child.listenerCount("exit"), 0);
  assert.deepEqual(value.signals, []);
  assert.deepEqual(value.failures, []);
}

function observed(value) {
  assert.equal(value.observations.length, 1, "Same initial snapshot observation must be recorded");
  assert.ok(value.observations[0], "Missing root must retain a bounded diagnostic projection");
  return value.observations[0];
}

test("empty initial snapshot records the missing target without gaining custody", () => {
  const value = fixture();
  rejectWithoutAuthority(value);
  assert.deepEqual(observed(value), {
    schemaVersion: 1,
    targetPid: 42,
    expectedParentPid: 99,
    snapshotRows: 0,
    matchingPidRows: 0,
    matches: [],
    truncated: false,
    boundary,
  });
});

test("unrelated rows expose their count but no foreign PID or private metadata", () => {
  const value = fixture([
    { pid: 701, ppid: 702, birth, path: "SECRET path", argv: "SECRET argv", env: "SECRET env" },
  ]);
  rejectWithoutAuthority(value);
  const result = observed(value);
  assert.equal(result.snapshotRows, 1);
  assert.equal(result.matchingPidRows, 0);
  assert.deepEqual(result.matches, []);
  assert.doesNotMatch(JSON.stringify(result), /701|702|SECRET|path|argv|env/);
});

test("matching target with another parent records only that target's PPID and birth", () => {
  const value = fixture([{ pid: 42, ppid: 98, birth, path: "SECRET" }]);
  rejectWithoutAuthority(value);
  assert.deepEqual(observed(value).matches, [{ ppid: 98, birthAvailable: true, birth }]);
  assert.equal(observed(value).matchingPidRows, 1);
  assert.doesNotMatch(JSON.stringify(observed(value)), /SECRET|path/);
});

test("matching target without full birth remains an identity failure", () => {
  const value = fixture([{ pid: 42, ppid: 99, birth: "" }]);
  rejectWithoutAuthority(value);
  assert.deepEqual(observed(value).matches, [{ ppid: 99, birthAvailable: false, birth: null }]);
  assert.equal(observed(value).matchingPidRows, 1);
});

test("an exact root preserves the existing normal-exit path without reporting failure metadata", async () => {
  const value = fixture([{ pid: 42, ppid: 99, birth }]);
  const monitor = watchElectronTestProcess(value.child, value.options);
  assert.equal(value.queries(), 1);
  assert.deepEqual(value.observations, []);
  assert.equal(value.intervals.size, 1);
  assert.equal(value.timeouts.size, 1);
  value.setRows([]);
  value.child.exitCode = 0;
  value.child.emit("exit", 0, null);
  const completed = await monitor.completed;
  assert.equal(completed.status, "cleaned");
  assert.deepEqual(completed.owned, [{ pid: 42, ppid: 99, birth }]);
  assert.deepEqual(completed.remaining, []);
  assert.deepEqual(value.observations, []);
  assert.deepEqual(value.signals, []);
  assert.equal(value.timeouts.size + value.intervals.size, 0);
});

test("a throwing optional observer cannot replace the original error or create authority", () => {
  const value = fixture();
  let calls = 0;
  value.options.onInitialIdentityFailure = () => {
    calls++;
    throw Error("PRIVATE observer failure");
  };
  rejectWithoutAuthority(value);
  assert.equal(calls, 1);
});

test("projection is bounded, copied and excludes malformed birth and extra fields", () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({
    pid: 42,
    ppid: 80 + index,
    birth: index === 0 ? "PRIVATE path pretending to be birth" : birth,
    argv: ["PRIVATE"],
  }));
  const value = fixture(rows);
  rejectWithoutAuthority(value);
  const result = observed(value);
  assert.equal(result.snapshotRows, 6);
  assert.equal(result.matchingPidRows, 6);
  assert.equal(result.matches.length, 4);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 2048);
  assert.deepEqual(result.matches[0], { ppid: 80, birthAvailable: false, birth: null });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|argv/);
  rows[1].ppid = 999;
  rows[1].birth = "changed";
  assert.deepEqual(result.matches[1], { ppid: 81, birthAvailable: true, birth });
  result.matches[2].ppid = 777;
  assert.equal(rows[2].ppid, 82, "Observer copies cannot alter the authority snapshot");
});

test("a later zero exit cannot repair the failed initial identity gate", () => {
  const value = fixture();
  rejectWithoutAuthority(value);
  const result = observed(value);
  value.setRows([{ pid: 42, ppid: 99, birth }]);
  value.child.exitCode = 0;
  value.child.emit("exit", 0, null);
  assert.equal(value.queries(), 1);
  assert.equal(value.child.listenerCount("exit"), 0);
  assert.equal(value.timeouts.size + value.intervals.size, 0);
  assert.deepEqual(value.signals, []);
  assert.deepEqual(result.matches, []);
  assert.equal(result.matchingPidRows, 0);
});

test("an initial query exception still bypasses the missing-root observer without retry", () => {
  const value = fixture();
  let queries = 0;
  value.options.snapshotProcesses = () => {
    queries++;
    throw Error("mock initial query failed");
  };
  assert.throws(() => watchElectronTestProcess(value.child, value.options), {
    name: "Error",
    message: "Cannot establish Electron test process identity: mock initial query failed",
  });
  assert.equal(queries, 1);
  assert.deepEqual(value.observations, []);
  assert.deepEqual(value.signals, []);
  assert.equal(value.timeouts.size + value.intervals.size, 0);
});

// Execute the actual complete exported runner function with injected in-memory
// dependencies. Do not import its native entry or any of its package closure.
const runnerSource = readFileSync(
  new URL("./smoke-windows-nsis-install.mjs", import.meta.url),
  "utf8",
);
const runnerStart = "export async function runNsisOwnedProcess({";
const runnerEnd = "\nexport async function runWindowsNsisAcceptance(args) {";
assert.equal(runnerSource.split(runnerStart).length, 2);
assert.equal(runnerSource.split(runnerEnd).length, 2);
const runnerFunction = runnerSource.slice(
  runnerSource.indexOf(runnerStart) + "export ".length,
  runnerSource.indexOf(runnerEnd),
);
const compileRunner = new Function(
  "assert",
  "spawn",
  "watchElectronTestProcess",
  "snapshotElectronTestProcesses",
  "createNsisReplacementRoleObserver",
  "MAX_LOG",
  "BUDGETS",
  "join",
  "writeFileSync",
  "plainFile",
  "safeError",
  "assertNormalNsisProcess",
  "process",
  "setTimeout",
  "clearTimeout",
  `return (${runnerFunction});`,
);

test("actual NSIS runner retains observation separately and late exit0 cannot promote the failed operation", async () => {
  const value = fixture();
  const logFiles = new Map();
  const hash = "a".repeat(64);
  const fakeProcess = { pid: 99, kill: deny("runner process.kill") };
  const run = compileRunner(
    assert,
    deny("runner default spawn"),
    watchElectronTestProcess,
    deny("runner default snapshot"),
    deny("runner replacement observer"),
    1024 * 1024,
    { closeAfterCustody: 5000 },
    join,
    (path, bytes) => logFiles.set(path, Buffer.from(bytes)),
    async () => ({ size: 1, sha256: hash }),
    (error) => ({ name: error.name, message: error.message }),
    deny("runner acceptance after failed identity"),
    fakeProcess,
    value.options.setTimeout,
    value.options.clearTimeout,
  );
  const report = { processes: [] };
  const checkpoints = [];
  await assert.rejects(
    run({
      executable: "owned-uninstaller.exe",
      args: ["/S", "/currentuser", "_?=owned installation"],
      environment: { OWNED: "inert fixture" },
      cwd: "owned-fixture",
      label: "uninstall",
      timeoutMs: 180_000,
      report,
      checkpoint: (kind) => checkpoints.push(kind),
      spawnProcess: () => value.child,
      takeSnapshot: value.options.snapshotProcesses,
      watch: (child, options) => watchElectronTestProcess(child, { ...value.options, ...options }),
    }),
    { name: "Error", message: missingIdentity },
  );
  const operation = report.processes[0];
  assert.ok(operation.initialIdentityObservation, "Runner must retain the actual watchdog DTO");
  assert.equal(operation.initialIdentityObservation.targetPid, 42);
  assert.equal(operation.initialIdentityObservation.expectedParentPid, 99);
  assert.equal(operation.initialIdentityObservation.snapshotRows, 0);
  assert.deepEqual(operation.initialIdentityObservation.matches, []);
  assert.equal(operation.status, "failed");
  assert.equal(operation.failure.message, missingIdentity);
  assert.equal(operation.child.birth, undefined);
  assert.equal(operation.result, null);
  assert.equal(operation.settlement, null);
  assert.equal(report.unprovenProcess, true);
  assert.equal(value.child.unreferenced, true);
  assert.equal(value.child.stdout.destroyed, true);
  assert.equal(value.child.stderr.destroyed, true);
  assert.equal(value.queries(), 1);
  assert.equal(value.timeouts.size + value.intervals.size, 0);
  assert.deepEqual(operation.signalRequests, []);
  assert.deepEqual(checkpoints, ["process-spawn", "process-first-error", "process-final"]);
  value.child.exitCode = 0;
  value.child.emit("exit", 0, null);
  value.child.emit("close", 0, null);
  assert.deepEqual(operation.exitObserved, { code: 0, signal: null });
  assert.equal(operation.status, "failed");
  assert.equal(operation.result, null);
  assert.equal(operation.settlement, null);
  assert.equal(operation.child.birth, undefined);
  assert.deepEqual(operation.cachedExit, {
    code: null,
    signal: null,
    boundary: "Cached ChildProcess observation, not OS liveness",
  });
  assert.deepEqual(checkpoints, [
    "process-spawn",
    "process-first-error",
    "process-final",
    "process-exit",
  ]);
  assert.equal(logFiles.size, 2, "Only the two inert initial log writes are performed");
});

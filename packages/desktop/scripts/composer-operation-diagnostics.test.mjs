/** Finite observer contracts. Never imports the Composer entry, SDK or Electron. */
import assert from "node:assert/strict";
import children from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// Before dynamic imports: all real process/query/signal transports are forbidden.
const restored = [];
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const original = children[name];
  children[name] = () => {
    throw Error("Pure Composer observer forbids real child_process." + name);
  };
  restored.push(() => {
    children[name] = original;
  });
}
const originalKill = process.kill;
process.kill = () => {
  throw Error("Pure Composer observer forbids real signals");
};
syncBuiltinESMExports();
after(() => {
  for (const restore of restored) restore();
  process.kill = originalKill;
  syncBuiltinESMExports();
});
const { createComposerOperationDiagnostics, composerAcceptanceComplete, COMPOSER_GUARD_FILES } =
  await import("./composer-operation-diagnostics.mjs");
const { observeElectronDiagnostic } = await import("./electron-harness.mjs");
const source = (name) =>
  fs.readFileSync(new URL(name, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const harness = source("./electron-harness.mjs");
const driver = source("./e2e-composer-reference-operations.mjs");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function between(text, start, end) {
  const begin = text.indexOf(start);
  assert.ok(begin >= 0, "Actual production seam start exists");
  assert.equal(text.indexOf(start, begin + 1), -1, "Actual production seam is unique");
  const finish = text.indexOf(end, begin + start.length);
  assert.ok(finish > begin, "Actual production seam end exists");
  return text.slice(begin + start.length, finish);
}
const identityCatch = between(
  harness,
  '    } catch (error) {\n      observeElectronDiagnostic(diagnostics, "error", error, captured);',
  "    } finally {\n      transport.restoreSpawn();",
);
const actualIdentityCatch = new AsyncFunction(
  "diagnostics",
  "captured",
  "custody",
  "error",
  "observeElectronDiagnostic",
  'observeElectronDiagnostic(diagnostics, "error", error, captured);' + identityCatch,
);
const signalBody = between(driver, "        signalProcess: (pid, signal) => {", "\n        },");
const actualSignal = (diagnostics, kill) =>
  new Function(
    "diagnostics",
    "observeElectronDiagnostic",
    "process",
    "return (pid, signal) => {" + signalBody + "\n};",
  )(diagnostics, observeElectronDiagnostic, { kill });
const finalTail = between(
  driver,
  "\n} finally {\n  const cleanup = diagnostics.cleanup(",
  "\n}\nconsole.log(",
);
const actualFinalTail = new AsyncFunction(
  "report",
  "failure",
  "diagnostics",
  "captured",
  "monitor",
  "processClosed",
  "electron",
  "isolated",
  "writeFile",
  "join",
  "evidence",
  "assert",
  "assertSourceElectronTransportSettled",
  "composerAcceptanceComplete",
  "const cleanup = diagnostics.cleanup(" + finalTail + "\nreturn { report, failure };",
);
function fixture(options = {}) {
  const evidence = join(tmpdir(), "inert-composer-evidence"),
    home = join(tmpdir(), "inert-composer-home");
  const files = new Map(),
    handles = new Map();
  const records = new Map(
    COMPOSER_GUARD_FILES.slice(0, 2).map((name) => [
      join(home, name),
      Buffer.from("owned guard\n"),
    ]),
  );
  const state = { fault: null, reads: 0, closes: 0, opened: 0, mutate: false, statCalls: 0 };
  const metadata = (path) => {
    if (path === home)
      return { dev: 1n, ino: 1n, isDirectory: () => true, isSymbolicLink: () => false };
    const bytes = records.get(path);
    if (!bytes) {
      const error = Error("missing");
      error.code = "ENOENT";
      throw error;
    }
    return {
      dev: 1n,
      ino: BigInt([...records.keys()].indexOf(path) + 2),
      size: BigInt(bytes.length),
      mtimeNs: 1n,
      ctimeNs: 1n,
      isFile: () => true,
      isSymbolicLink: () => false,
    };
  };
  const io = {
    writeFileSync(path, bytes, flags) {
      if (state.fault === "write") throw Error("synthetic write fault");
      if (flags?.flag === "wx" && files.has(path)) throw Error("exclusive output reused");
      files.set(path, Buffer.from(bytes));
    },
    appendFileSync(path, bytes) {
      if (state.fault === "append") throw Error("synthetic append fault");
      files.set(path, Buffer.concat([files.get(path) ?? Buffer.alloc(0), Buffer.from(bytes)]));
    },
    renameSync(from, to) {
      if (state.fault === "rename") throw Error("synthetic rename fault");
      files.set(to, files.get(from));
      files.delete(from);
    },
    lstatSync: metadata,
    openSync(path) {
      const fd = ++state.opened;
      handles.set(fd, path);
      return fd;
    },
    fstatSync(fd) {
      const row = metadata(handles.get(fd));
      if (state.mutate && ++state.statCalls > 1) row.ctimeNs = 2n;
      return row;
    },
    readSync(fd, target, offset, length, position) {
      state.reads++;
      return records.get(handles.get(fd)).copy(target, offset, position, position + length);
    },
    closeSync(fd) {
      state.closes++;
      handles.delete(fd);
    },
    ...options.io,
  };
  const controller = new EventEmitter();
  const diagnostics = createComposerOperationDiagnostics({
    evidence,
    ownedRoots: [evidence],
    controller,
    io,
  });
  return {
    evidence,
    home,
    files,
    records,
    state,
    io,
    controller,
    diagnostics,
    read: () => JSON.parse(files.get(join(evidence, "diagnostics.json")).toString()),
    journal: () =>
      files.get(join(evidence, "diagnostics.jsonl")).toString().trim().split("\n").map(JSON.parse),
  };
}
const child = () =>
  Object.assign(new EventEmitter(), {
    pid: 42,
    exitCode: null,
    signalCode: null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });

test("pending/controller observations never claim a Main exit or final acceptance", () => {
  const f = fixture();
  assert.equal(f.read().status, "incomplete");
  assert.equal(f.read().main.exitObserved, null);
  f.controller.emit("exit", 1);
  assert.equal(f.read().controllerExit.code, 1);
  assert.match(f.read().controllerExit.boundary, /not the Main/);
  assert.equal(f.read().main.exitObserved, null);
  assert.equal(f.read().finalReportWritten, false);
});

for (const exitedBeforeError of [false, true])
  test(`actual identity catch preserves first error before same cleanup; earlier exit=${exitedBeforeError}`, async () => {
    const f = fixture(),
      main = child();
    f.diagnostics.observeChild(main);
    f.diagnostics.phase("harness-main-identity");
    main.stderr.emit("data", Buffer.from("owned before error\n"));
    if (exitedBeforeError) {
      main.exitCode = 1;
      main.emit("exit", 1, null);
    }
    const original = new Error("Resulting promise was garbage collected.");
    original.stack = `Error: GC\n    at owned (${f.evidence}/caller.mjs:197:38)\n    at foreign (/operator/private.mjs:2:1)`;
    let requests = 0,
      terminations = 0,
      caught;
    const kill = actualSignal(f.diagnostics, (pid, signal) => {
      requests++;
      assert.equal(pid, 42);
      assert.equal(signal, "SIGTERM");
      assert.equal(f.read().diagnostics.firstError.message, original.message);
      assert.equal(f.read().diagnostics.signals.length, 1);
    });
    const monitor = {
      terminate() {
        terminations++;
        const first = f.read().diagnostics.firstError;
        assert.equal(first.phase, "harness-main-identity");
        assert.equal(first.child.exitObserved, exitedBeforeError);
        kill(42, "SIGTERM");
        main.stderr.emit("data", Buffer.from("owned after request\n"));
        main.exitCode = 1;
        main.emit("exit", 1, null);
        main.emit("close", 1, null);
        return Promise.resolve({ status: "cleaned" });
      },
    };
    try {
      await actualIdentityCatch(f.diagnostics, main, monitor, original, observeElectronDiagnostic);
    } catch (error) {
      caught = error;
    }
    assert.equal(caught, original);
    assert.equal(terminations, 1);
    assert.equal(requests, 1);
    f.diagnostics.error(new Error("later normal-exit gate"), main);
    assert.equal(f.read().diagnostics.firstError.message, original.message);
    assert.match(f.read().diagnostics.firstError.stack, /caller/);
    assert.doesNotMatch(f.read().diagnostics.firstError.stack, /operator/);
    const kinds = f.journal().map((row) => row.kind);
    assert.ok(kinds.indexOf("first-error") < kinds.indexOf("cleanup-request"));
    assert.ok(kinds.indexOf("cleanup-request") < kinds.indexOf("observed-cleanup-signal-request"));
    assert.ok(kinds.indexOf("observed-cleanup-signal-request") < kinds.indexOf("child-close"));
    if (exitedBeforeError) assert.ok(kinds.indexOf("child-exit") < kinds.indexOf("first-error"));
    else assert.ok(kinds.indexOf("observed-cleanup-signal-request") < kinds.indexOf("child-exit"));
    assert.equal(f.read().main.exitCode, 1);
  });

test("diagnostic write faults cannot skip the actual authorized signal delegate", async () => {
  const f = fixture(),
    main = child();
  f.state.fault = "write";
  let killed = 0;
  const original = Error("original identity error");
  let caught;
  try {
    await actualIdentityCatch(
      f.diagnostics,
      main,
      {
        terminate() {
          actualSignal(f.diagnostics, () => killed++)(42, "SIGTERM");
          return Promise.resolve({ status: "cleaned" });
        },
      },
      original,
      observeElectronDiagnostic,
    );
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, original);
  assert.equal(killed, 1);
  assert.equal(f.diagnostics.hasRecordingFailure(), true);
  assert.equal(f.diagnostics.receipt.diagnostics.firstError.message, original.message);
});

test("atomic snapshot fault preserves the prior pending and original first-error journal", () => {
  const f = fixture();
  f.state.fault = "rename";
  f.diagnostics.error(Error("original metadata rejection"));
  assert.equal(f.read().diagnostics.firstError, null);
  assert.equal(
    f.journal().find((x) => x.kind === "first-error").observation.message,
    "original metadata rejection",
  );
  assert.equal(f.diagnostics.hasRecordingFailure(), true);
});

test("stdio keeps a bounded raw byte tail and truncation is not a green recorder", () => {
  const f = fixture(),
    main = child();
  f.diagnostics.observeChild(main);
  main.stdout.emit("data", Buffer.alloc(1024 * 1024, 65));
  main.stdout.emit("data", Buffer.from([0xff, 0x00, 0x42]));
  const actual = f.files.get(join(f.evidence, "main.stdout.log"));
  assert.equal(actual.length, 1024 * 1024);
  assert.deepEqual(actual.subarray(-3), Buffer.from([0xff, 0x00, 0x42]));
  assert.equal(f.read().logs.stdout.observedBytes, 1024 * 1024 + 3);
  assert.equal(f.read().logs.stdout.truncated, true);
  assert.equal(f.diagnostics.hasRecordingFailure(), true);
});

test("guard copying is limited to fixed owned files; absence, oversized and changed records are explicit", () => {
  const f = fixture();
  f.diagnostics.exportGuards(f.home, true);
  assert.equal(f.read().guards["network-guard.jsonl"].status, "copied");
  assert.equal(f.read().guards["spawned-workers.jsonl"].status, "missing");
  assert.equal(f.diagnostics.hasRequiredGuards(), true);
  assert.equal(f.state.closes, 2);
  const capped = fixture();
  capped.records.set(join(capped.home, COMPOSER_GUARD_FILES[0]), Buffer.alloc(64 * 1024 + 1));
  capped.diagnostics.exportGuards(capped.home, true);
  assert.equal(capped.read().guards[COMPOSER_GUARD_FILES[0]].status, "error");
  assert.equal(capped.diagnostics.hasRecordingFailure(), true);
  assert.equal(capped.read().guards[COMPOSER_GUARD_FILES[1]].status, "copied");
  const linked = fixture();
  const originalLstat = linked.io.lstatSync,
    originalOpen = linked.io.openSync;
  const linkedPath = join(linked.home, COMPOSER_GUARD_FILES[0]);
  let linkedOpens = 0;
  linked.io.lstatSync = (path) => ({
    ...originalLstat(path),
    ...(path === linkedPath ? { isSymbolicLink: () => true } : {}),
  });
  linked.io.openSync = (path) => {
    if (path === linkedPath) linkedOpens++;
    return originalOpen(path);
  };
  linked.diagnostics.exportGuards(linked.home, true);
  assert.equal(linked.read().guards[COMPOSER_GUARD_FILES[0]].status, "error");
  assert.equal(linkedOpens, 0);
  const changed = fixture();
  changed.state.mutate = true;
  changed.diagnostics.exportGuards(changed.home, true);
  assert.equal(changed.read().guards[COMPOSER_GUARD_FILES[0]].status, "error");
  assert.equal(changed.state.closes, 2);
  const unproven = fixture();
  unproven.diagnostics.exportGuards(unproven.home, false);
  assert.equal(unproven.state.opened, 0);
  assert.equal(unproven.diagnostics.hasRequiredGuards(), false);
});

test("actual bounded filesystem export reads only three owned records, with no generated content for missing", (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), "codeshell-composer-observer-owned-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const evidence = join(root, "evidence"),
    home = join(root, "home");
  fs.mkdirSync(evidence);
  fs.mkdirSync(home);
  fs.writeFileSync(join(home, "network-guard.jsonl"), '{"pid":42}\n');
  fs.writeFileSync(join(home, "real-keyring-bootstrap.jsonl"), '{"pid":42,"mockKeychain":false}\n');
  const d = createComposerOperationDiagnostics({ evidence, controller: new EventEmitter() });
  d.exportGuards(home, true);
  assert.equal(fs.readFileSync(join(evidence, "network-guard.jsonl"), "utf8"), '{"pid":42}\n');
  assert.equal(d.receipt.guards["spawned-workers.jsonl"].status, "missing");
  assert.equal(fs.existsSync(join(evidence, "spawned-workers.jsonl")), false);
  assert.equal(d.hasRecordingFailure(), false);
});

async function runTail(mode) {
  const f = fixture(),
    main = child();
  f.diagnostics.observeChild(main);
  const original = mode === "UI failure" ? Error("original UI rejection") : undefined;
  if (original) f.diagnostics.error(original, main);
  const report = {
    result: "pass",
    cases: Array(mode === "missing case" ? 8 : 9).fill({}),
    errors: [],
  };
  if (mode === "diagnostic fault") f.state.fault = "rename";
  let removed = 0,
    closed = 0,
    terminated = 0,
    written = 0;
  const result = await actualFinalTail(
    report,
    original,
    f.diagnostics,
    main,
    {
      terminate() {
        terminated++;
        return Promise.resolve({ status: "cleaned", remainingCount: 0, queryFailed: false });
      },
    },
    Promise.resolve({ code: mode === "abnormal Main" ? 1 : 0, signal: null }),
    {
      close() {
        closed++;
        return Promise.resolve();
      },
    },
    {
      home: f.home,
      async cleanup() {
        removed++;
        if (mode === "post-removal diagnostic fault") f.state.fault = "write";
      },
    },
    async () => {
      written++;
      if (mode === "final report fault") throw Error("original final report write failed");
    },
    join,
    f.evidence,
    assert,
    () => {
      if (mode === "late transport failure") throw Error("late transport refusal");
      return {};
    },
    composerAcceptanceComplete,
  );
  return { ...f, ...result, original, counts: { removed, closed, terminated, written } };
}

test("actual final tail accepts only complete normal proof before removing HOME", async () => {
  const f = await runTail("pass");
  assert.equal(f.report.result, "pass");
  assert.equal(f.report.privateHomeRemoved, true);
  assert.deepEqual(f.counts, { removed: 1, closed: 1, terminated: 1, written: 1 });
});
for (const mode of [
  "UI failure",
  "missing case",
  "abnormal Main",
  "late transport failure",
  "diagnostic fault",
])
  test(`actual final tail retains HOME on ${mode} without relaxing original normal gate`, async () => {
    const f = await runTail(mode);
    assert.equal(f.report.result, "fail");
    assert.equal(f.report.privateHomeRemoved, undefined);
    assert.equal(f.report.retainedHome, f.home);
    assert.equal(f.counts.removed, 0);
    assert.equal(f.counts.closed, 1);
    assert.equal(f.counts.terminated, 1);
    if (f.original) {
      assert.equal(f.failure, f.original);
      assert.equal(f.read().diagnostics.firstError.message, f.original.message);
    }
  });
for (const mode of ["post-removal diagnostic fault", "final report fault"])
  test(`actual final tail reports ${mode} truthfully after HOME already removed`, async () => {
    const f = await runTail(mode);
    assert.equal(f.report.result, "fail");
    assert.equal(f.report.privateHomeRemoved, true);
    assert.equal(f.counts.removed, 1);
    assert.ok(f.report.errors.length > 0);
    if (mode === "final report fault") assert.match(f.failure.message, /original final report/);
    else assert.equal(f.diagnostics.hasRecordingFailure(), true);
  });

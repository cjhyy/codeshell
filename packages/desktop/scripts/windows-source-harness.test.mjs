/** Pure Windows-shaped installed-Playwright calls. No Electron or cmd is run. */
import assert from "node:assert/strict";
import children from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertSourceElectronTransportSettled,
  createElectronTestDiagnostics,
  launchCodeShellElectron,
  verifyElectronMainIdentity,
} from "./electron-harness.mjs";

let nextPid = 700000;
async function fakeLaunch(t, mode = "success") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codeshell-source-win-transport-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "owned home 中文"),
    appDir = join(root, "owned workspace 中文");
  await mkdir(home);
  await mkdir(appDir);
  const executable = join(root, "owned Electron 中文.exe"),
    loader = join(root, "installed loader 中文.js");
  await writeFile(executable, "Not an executable: pure fixture identity only");
  await writeFile(loader, "Not loaded: reviewed vector fixture only");
  const child = new EventEmitter();
  child.pid = ++nextPid;
  child.exitCode = child.signalCode = null;
  let unrefs = 0,
    quits = 0,
    terminations = 0,
    spawns = 0,
    protocolReads = 0,
    publicEvaluations = 0;
  child.unref = () => unrefs++;
  child.stdout = child.stderr = { unref() {} };
  const order = [],
    failures = [];
  const diagnostics = createElectronTestDiagnostics({ ownedRoots: [root] });
  const settlement = { status: "cleaned", queryFailed: false, remainingCount: 0 };
  const monitor = Object.assign(() => {}, {
    snapshotTiming: { count: 3, totalMs: 40, maxMs: 20, recent: [10, 10, 20], maxTickGapMs: 1001 },
    completed: Promise.resolve(settlement),
    terminate() {
      terminations++;
      if (mode === "evaluate rejection") child.exitCode = 1;
      return Promise.resolve(settlement);
    },
  });
  const original = children.spawn;
  const outerCapture = (children.spawn = (command, args, options) => {
    order.push("outer capture sees direct Main");
    spawns++;
    assert.equal(command, executable);
    assert.deepEqual(args.slice(0, 4), ["-r", loader, "--inspect=0", "--remote-debugging-port=0"]);
    assert.ok(args.includes('owned argument "quoted" %PATH% & ^ 中文'));
    assert.equal(options.shell, false);
    assert.equal(options.windowsVerbatimArguments, false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.detached, false);
    assert.equal(options.cwd, appDir);
    assert.equal(options.env.HOME, home);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe", "pipe", "pipe"]);
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    children.spawn = original;
    syncBuiltinESMExports();
  });
  const app = {
    process: () => child,
    evaluate: async () => {
      publicEvaluations++;
      return "owned unrelated public evaluation";
    },
    close: async () => {
      quits++;
    },
  };
  const connection = { _closed: false, _sessions: new Map() };
  const session = {
    _connection: connection,
    _sessionId: "",
    _closed: false,
    _crashed: false,
    send: async (method, params) => {
      protocolReads++;
      assert.equal(method, "Runtime.evaluate");
      assert.deepEqual(params, {
        expression:
          "({pid:process.pid,ppid:process.ppid,executable:process.execPath,home:process.env.HOME})",
        contextId: 37,
        returnByValue: true,
        awaitPromise: false,
      });
      if (mode === "null rejection") throw null;
      if (mode === "undefined rejection") throw undefined;
      if (mode === "hostile rejection")
        throw new Proxy(
          {},
          {
            get() {
              throw Error("Private getter detail");
            },
          },
        );
      if (["evaluate rejection", "exited before evaluate rejection"].includes(mode)) {
        if (mode === "exited before evaluate rejection") child.exitCode = 1;
        const error = new Error("Resulting promise was garbage collected.");
        error.stack = `Error: ${error.message}\n    at owned (${appDir}/caller.mjs:1:1)\n    at foreign (/foreign/operator/caller.mjs:2:1)`;
        throw error;
      }
      return {
        result: {
          type: "object",
          value: {
            pid: mode === "wrong Main" ? child.pid + 1 : child.pid,
            ppid: mode === "wrong parent" ? process.pid + 1 : process.pid,
            executable: mode === "wrong executable" ? loader : executable,
            home: mode === "wrong identity HOME" ? home + "-foreign" : home,
          },
        },
      };
    },
  };
  connection.rootSession = session;
  connection._sessions.set("", session);
  const context = { delegate: { _client: session, _contextId: 37 } };
  const implementation = {
    process: () => child,
    _nodeConnection: connection,
    _nodeSession: session,
    _nodeExecutionContext: context,
    _nodeElectronHandlePromise: Promise.resolve({
      _context: context,
      _disposed: false,
      _objectId: "owned Main module handle",
    }),
  };
  app._connection = {
    toImpl(value) {
      assert.equal(value, app);
      return implementation;
    },
  };
  if (mode === "remote client") delete app._connection.toImpl;
  const run = () =>
    launchCodeShellElectron(
      { appDir, home, mainEntry: 'owned argument "quoted" %PATH% & ^ 中文' },
      {
        platform: "win32",
        preflight: () => {},
        reportFailure: (message) => failures.push(message),
        windowsLaunchDetails: async () => ({ executable, loader, playwrightVersion: "1.64.0" }),
        watch(captured) {
          order.push("early existing birth custody");
          assert.equal(captured, child);
          if (mode === "no custody") throw Error("Synthetic birth query failed");
          return monitor;
        },
        diagnostics,
        launch: async (options) => {
          const argv = ["-r", loader, "--inspect=0", "--remote-debugging-port=0", ...options.args];
          // Exact coreBundle45543/45698 encoding, independently spelled here.
          let command = [executable, ...argv]
            .map((arg) => `"${arg.replace(/"/g, '\\"')}"`)
            .join(" ");
          if (mode === "wrong command") command += ' "unexpected"';
          const env =
            mode === "wrong HOME" ? { ...options.env, HOME: home + "-foreign" } : options.env;
          const spawned = children.spawn(command, [], {
            shell: true,
            detached: false,
            cwd: appDir,
            env,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
          });
          assert.equal(spawned, child);
          order.push("Playwright handshake proceeds with same Main");
          if (mode === "launch rejection") throw Error("Synthetic handshake failure");
          return app;
        },
      },
    );
  return {
    run,
    app,
    child,
    monitor,
    outerCapture,
    order,
    failures,
    diagnostics: diagnostics.receipt,
    observer: diagnostics,
    identityContext: { executable, home },
    state: () => ({ unrefs, quits, terminations, spawns, protocolReads, publicEvaluations }),
  };
}

test("a first-window failure sidecar captures the registered watchdog timing", async (t) => {
  const fixture = await fakeLaunch(t, "normal");
  await fixture.run();
  fixture.observer.error(new Error("first-window timeout"), fixture.child);
  assert.deepEqual(fixture.diagnostics.snapshotTiming, fixture.monitor.snapshotTiming);
  fixture.diagnostics.snapshotTiming.recent[0] = -1;
  assert.equal(fixture.monitor.snapshotTiming.recent[0], 10);
});

test("a throwing timing getter cannot replace the error or interrupt custody cleanup", async (t) => {
  const fixture = await fakeLaunch(t, "evaluate rejection");
  Object.defineProperty(fixture.monitor, "snapshotTiming", {
    get() {
      throw Error("Private timing getter");
    },
  });
  await assert.rejects(fixture.run(), /Resulting promise was garbage collected/);
  assert.equal(fixture.state().terminations, 1);
  assert.equal(fixture.diagnostics.firstError.phase, "harness-main-identity");
  assert.equal(fixture.diagnostics.snapshotTiming, undefined);
});

test("source Windows launch normalizes the installed loader vector before existing early custody", async (t) => {
  const fixture = await fakeLaunch(t);
  assert.equal(await fixture.run(), fixture.app);
  assert.deepEqual(fixture.order, [
    "outer capture sees direct Main",
    "early existing birth custody",
    "Playwright handshake proceeds with same Main",
  ]);
  assert.equal(
    children.spawn,
    fixture.outerCapture,
    "Restore the previous fixture hook, not the OS spawn",
  );
  assert.equal(fixture.app.process(), fixture.child);
  assert.equal(fixture.app.__sourceMainIdentity.pid, fixture.child.pid);
  assert.equal(
    assertSourceElectronTransportSettled(fixture.child, { required: true }).directMain,
    true,
  );
  assert.deepEqual(fixture.failures, []);
});

for (const mode of ["wrong command", "wrong HOME"])
  test(`source Windows ${mode} refuses before spawn and restores the outer hook`, async (t) => {
    const fixture = await fakeLaunch(t, mode);
    await assert.rejects(fixture.run(), /non-exact Windows Playwright Electron spawn/);
    assert.equal(fixture.state().spawns, 0);
    assert.equal(fixture.state().terminations, 0);
    assert.equal(fixture.state().quits, 0);
    assert.equal(children.spawn, fixture.outerCapture);
  });

test("source Windows handshake rejection uses the same early monitor and restores transport", async (t) => {
  const fixture = await fakeLaunch(t, "launch rejection");
  await assert.rejects(fixture.run(), /Synthetic handshake failure/);
  assert.equal(fixture.state().terminations, 1);
  assert.equal(fixture.state().quits, 0);
  assert.equal(children.spawn, fixture.outerCapture);
  assert.equal(fixture.diagnostics.firstError.phase, "harness-launch");
  assert.equal(fixture.diagnostics.cleanups[0].trigger, "harness-error");
});

for (const mode of ["evaluate rejection", "exited before evaluate rejection"])
  test(`source Windows ${mode} preserves the first error before custody cleanup`, async (t) => {
    const fixture = await fakeLaunch(t, mode);
    await assert.rejects(fixture.run(), /Resulting promise was garbage collected/);
    const diagnostic = fixture.diagnostics;
    assert.equal(diagnostic.firstError.phase, "harness-main-identity");
    assert.match(diagnostic.firstError.stack, /owned.*caller\.mjs/);
    assert.doesNotMatch(diagnostic.firstError.stack, /foreign|operator/);
    assert.equal(diagnostic.firstError.child.exitObserved, mode !== "evaluate rejection");
    const cleanup = diagnostic.cleanups[0];
    assert.equal(cleanup.before.exitObserved, mode !== "evaluate rejection");
    assert.equal(cleanup.requests[0].method, "monitor.terminate");
    assert.equal(cleanup.after.exitCode, 1);
    assert.equal(cleanup.after.signalCode, null);
    assert.ok(diagnostic.firstError.sequence < cleanup.sequence);
    assert.ok(cleanup.sequence < cleanup.requests[0].sequence);
    for (let i = 1; i < diagnostic.timeline.length; i++) {
      assert.ok(diagnostic.timeline[i].sequence > diagnostic.timeline[i - 1].sequence);
      assert.ok(diagnostic.timeline[i].elapsedMs >= diagnostic.timeline[i - 1].elapsedMs);
    }
    assert.equal(fixture.state().terminations, 1);
    assert.equal(fixture.state().quits, 0);
    assert.equal(children.spawn, fixture.outerCapture);
  });

for (const mode of ["null rejection", "undefined rejection", "hostile rejection"])
  test(`source Windows ${mode} still performs existing custody cleanup`, async (t) => {
    const fixture = await fakeLaunch(t, mode);
    let rejected = false;
    try {
      await fixture.run();
    } catch {
      // Node assert.rejects itself inspects properties of a hostile rejection.
      rejected = true;
    }
    assert.equal(rejected, true);
    assert.equal(fixture.diagnostics.firstError.phase, "harness-main-identity");
    assert.equal(fixture.state().terminations, 1);
    assert.equal(fixture.state().quits, 0);
    assert.equal(children.spawn, fixture.outerCapture);
    assert.doesNotMatch(JSON.stringify(fixture.diagnostics), /Private getter detail/);
  });

test("a throwing diagnostic observer cannot skip the existing Windows cleanup or replace its error", async (t) => {
  const fixture = await fakeLaunch(t, "evaluate rejection");
  for (const method of ["error", "cleanup", "request", "settled"])
    fixture.observer[method] = () => {
      throw Error("Diagnostic observer failure");
    };
  await assert.rejects(fixture.run(), /Resulting promise was garbage collected/);
  assert.equal(fixture.state().terminations, 1);
  assert.equal(fixture.state().quits, 0);
  assert.equal(fixture.diagnostics.recordingFailed, true);
  assert.equal(children.spawn, fixture.outerCapture);
});

test("source Windows missing birth identity never quits or signals the unknown process", async (t) => {
  const fixture = await fakeLaunch(t, "no custody");
  await assert.rejects(fixture.run(), /Synthetic birth query failed/);
  assert.equal(fixture.state().terminations, 0);
  assert.equal(fixture.state().quits, 0);
  assert.ok(fixture.state().unrefs > 0);
  assert.equal(children.spawn, fixture.outerCapture);
});

test("source Windows rejects a connected Main whose PID differs from the captured child", async (t) => {
  const fixture = await fakeLaunch(t, "wrong Main");
  await assert.rejects(fixture.run(), /Main PID differs/);
  assert.equal(fixture.state().terminations, 1);
  assert.equal(fixture.state().quits, 0);
});

for (const [mode, message] of [
  ["wrong parent", /Main parent differs/],
  ["wrong identity HOME", /Main HOME differs/],
  ["wrong executable", /Main executable differs/],
])
  test(`source Windows synchronous identity retains the ${mode} gate`, async (t) => {
    const fixture = await fakeLaunch(t, mode);
    await assert.rejects(fixture.run(), message);
    assert.equal(fixture.state().protocolReads, 1);
    assert.equal(fixture.state().publicEvaluations, 0);
    assert.equal(fixture.state().terminations, 1);
    assert.equal(fixture.state().quits, 0);
  });

test("source Windows remote clients fail before any identity read and still use existing custody", async (t) => {
  const fixture = await fakeLaunch(t, "remote client");
  await assert.rejects(fixture.run(), /requires in-process Playwright/);
  assert.equal(fixture.state().protocolReads, 0);
  assert.equal(fixture.state().publicEvaluations, 0);
  assert.equal(fixture.state().terminations, 1);
  assert.equal(fixture.state().quits, 0);
  assert.equal(fixture.diagnostics.firstError.phase, "harness-main-identity");
});

test("the same registered reader verifies later confinement without replacing public evaluation", async (t) => {
  const fixture = await fakeLaunch(t);
  await fixture.run();
  const identity = await verifyElectronMainIdentity(fixture.app, fixture.identityContext);
  assert.equal(identity.pid, fixture.child.pid);
  assert.equal(fixture.state().protocolReads, 2);
  assert.equal(fixture.state().publicEvaluations, 0);
  assert.equal(
    await fixture.app.evaluate(() => "not invoked by this pure fake"),
    "owned unrelated public evaluation",
  );
  assert.equal(fixture.state().publicEvaluations, 1);
  assert.equal(fixture.state().protocolReads, 2);
});

test("a late library taskkill cannot pass a settled source receipt even if exit code is zero", async (t) => {
  const fixture = await fakeLaunch(t);
  await fixture.run();
  const initial = fixture.app.__sourceWindowsTransport;
  assert.deepEqual(initial.failures, []);
  fixture.child.exitCode = 0;
  fixture.child.emit("exit", 0, null);
  const suppressed = children.spawnSync(`taskkill /pid ${fixture.child.pid} /T /F`, {
    shell: true,
    windowsHide: true,
  });
  assert.equal(suppressed.status, null);
  assert.ok(suppressed.error);
  await Promise.resolve();
  assert.equal(fixture.state().terminations, 1);
  assert.equal(fixture.state().quits, 0);
  assert.ok(fixture.failures.some((message) => message.includes("forced cleanup")));
  assert.throws(
    () => assertSourceElectronTransportSettled(fixture.child, { required: true }),
    /unsafe or forced cleanup/,
  );
  assert.deepEqual(
    initial.failures,
    [],
    "Initial receipt alone is insufficient; final gate reads live ledger",
  );
});

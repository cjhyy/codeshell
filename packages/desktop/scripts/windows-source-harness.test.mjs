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
  launchCodeShellElectron,
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
    spawns = 0;
  child.unref = () => unrefs++;
  child.stdout = child.stderr = { unref() {} };
  const order = [],
    failures = [];
  const settlement = { status: "cleaned", queryFailed: false, remainingCount: 0 };
  const monitor = Object.assign(() => {}, {
    completed: Promise.resolve(settlement),
    terminate() {
      terminations++;
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
    evaluate: async () => ({
      pid: mode === "wrong Main" ? child.pid + 1 : child.pid,
      ppid: process.pid,
      executable,
      home,
    }),
    close: async () => {
      quits++;
    },
  };
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
    state: () => ({ unrefs, quits, terminations, spawns }),
  };
}

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

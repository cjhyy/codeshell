import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { installWindowsElectronDirectTransport } from "./windows-electron-direct-transport.mjs";

function fixture(terminate = () => Promise.resolve({ status: "cleaned", remainingCount: 0 })) {
  const calls = [],
    failures = [];
  const child = Object.assign(new EventEmitter(), { pid: 4312, exitCode: null, signalCode: null });
  const monitor = { terminate, completed: Promise.resolve() };
  const children = {
    spawn: (...args) => {
      calls.push(args);
      return child;
    },
    spawnSync: () => {
      throw Error("Native taskkill must never execute");
    },
  };
  const executable = "C:\\Owned 目录\\Electron & tools\\electron.exe";
  const loader = "C:\\Reviewed Playwright\\loader.js";
  const home = "C:\\Owned 目录\\home";
  const args = ["--user-data-dir=C:\\Owned 目录\\home\\data"];
  const transport = installWindowsElectronDirectTransport(
    {
      executable,
      loader,
      home,
      cwd: home,
      args,
      platform: "win32",
      playwrightVersion: "1.64.0",
      onCapturedSpawn: () => monitor,
      reportFailure: (message) => failures.push(message),
    },
    { children, syncExports: () => {} },
  );
  // Literal independently transcribed from the installed 1.64 source vector;
  // intentionally do not generate the input with the helper being tested.
  const command =
    '"C:\\Owned 目录\\Electron & tools\\electron.exe" "-r" "C:\\Reviewed Playwright\\loader.js" "--inspect=0" "--remote-debugging-port=0" "--user-data-dir=C:\\Owned 目录\\home\\data"';
  const options = {
    shell: true,
    detached: false,
    cwd: home,
    env: { HOME: home, USERPROFILE: home },
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
  };
  return { children, calls, failures, child, transport, command, options };
}

test("independent reviewed Windows command preserves loader, exact raw arguments and real child", () => {
  const f = fixture();
  try {
    assert.equal(f.children.spawn(f.command, [], f.options), f.child);
    assert.deepEqual(f.calls[0], [
      "C:\\Owned 目录\\Electron & tools\\electron.exe",
      [
        "-r",
        "C:\\Reviewed Playwright\\loader.js",
        "--inspect=0",
        "--remote-debugging-port=0",
        "--user-data-dir=C:\\Owned 目录\\home\\data",
      ],
      { ...f.options, shell: false, windowsVerbatimArguments: false },
    ]);
    assert.deepEqual(f.failures, []);
  } finally {
    f.transport.restoreSpawn();
  }
});

for (const [name, terminate] of [
  ["unproven", () => Promise.resolve({ status: "unproven", remainingCount: 1 })],
  ["rejected", () => Promise.reject(Error("Owned cleanup rejection"))],
  [
    "thrown",
    () => {
      throw Error("Owned cleanup throw");
    },
  ],
]) {
  test(`library cleanup ${name} remains a failed receipt and cannot count as native success`, async () => {
    const f = fixture(terminate);
    f.children.spawn(f.command, [], f.options);
    f.transport.restoreSpawn();
    let result;
    try {
      result = f.children.spawnSync("taskkill /pid 4312 /T /F", { shell: true, windowsHide: true });
    } catch (error) {
      assert.match(error.message, /cleanup/);
    }
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(f.failures.length > 0);
    assert.ok(f.transport.receipt().failures.length > 0);
    assert.equal(f.transport.receipt().nativeTaskkillExecuted, false);
    assert.notEqual(result?.status, 0);
    assert.equal(f.calls.length, 1);
  });
}

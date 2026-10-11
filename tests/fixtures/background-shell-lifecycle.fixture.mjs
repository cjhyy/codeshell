import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { errorMonitor } from "node:events";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

const directory = realpathSync(process.env.CODESHELL_BG_LIFECYCLE_EVIDENCE);
const home = realpathSync(process.env.HOME);
const persist = (name, value) =>
  writeFileSync(join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
assert.equal(process.versions.bun, undefined);
assert.ok(Number(process.versions.node.split(".")[0]) >= 20);
assert.equal(homedir(), home);
assert.equal(process.env.USERPROFILE, home);
assert.equal(process.env.CODE_SHELL_HOME, join(home, ".code-shell"));
assert.equal(process.env.CODE_SHELL_DATA_ROOT, undefined);
assert.ok(home.startsWith(directory + "/"));
assert.equal(
  Object.keys(process.env).some((name) =>
    /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PROVIDER_KEY|^(?:HTTPS?|ALL)_PROXY$)/i.test(name),
  ),
  false,
);

// No HTTP is needed. These eight JS surfaces are guarded before Core import;
// this does not confine raw sockets, the OS, or the literal shell children.
let denied = 0;
const deny = () => {
  denied++;
  throw new Error("Background fixture denies HTTP");
};
globalThis.fetch = deny;
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
syncBuiltinESMExports();
const { request: namedRequest, get: namedGet } = await import("node:http");
const { get: namedHttpsGet } = await import("node:https");
for (const probe of [
  () => fetch("https://example.invalid"),
  () => fetch("http://127.0.0.1:9"),
  () => http.request("http://127.0.0.1:9"),
  () => http.get("http://127.0.0.1:9"),
  () => https.request("https://example.invalid"),
  () => namedRequest("http://127.0.0.1:9"),
  () => namedGet("http://127.0.0.1:9"),
  () => namedHttpsGet("https://example.invalid"),
])
  assert.throws(probe, /denies HTTP/);
persist("before-core.json", {
  phase: "before-first-Core-import",
  pid: process.pid,
  ppid: process.ppid,
  node: process.versions.node,
  executable: realpathSync(process.execPath),
  homeSha256: createHash("sha256").update(home).digest("hex"),
  negativeProbes: denied,
});

// Transparent exactly-once delegate. errorMonitor observes without handling
// 'error', so it cannot hide the original no-listener parent failure.
const actualSpawn = childProcess.spawn;
const children = [];
const managers = new Set();
const gate = join(directory, "inherited-pipe-release");
let shuttingDown = false;
let shutdownTask;
const waitFor = async (predicate) => {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Lifecycle did not settle within 3s");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
function shutdown() {
  if (shutdownTask) return shutdownTask;
  shuttingDown = true;
  shutdownTask = (async () => {
    const errors = [];
    // This also drains pipes held by a descendant whose shell already exited.
    writeFileSync(gate, "release", { mode: 0o600 });
    await Promise.all(
      [...managers].map(async (manager) => {
        try {
          await manager.killAll();
        } catch (error) {
          errors.push(String(error));
        }
      }),
    );
    try {
      await waitFor(() => children.every((owner) => owner.receipt.closed));
    } catch (error) {
      errors.push(String(error));
    }
    const complete = errors.length === 0 && children.every((owner) => owner.receipt.closed);
    persist("shutdown.json", {
      complete,
      errors,
      children: children.map((owner) => owner.receipt),
    });
    return complete;
  })();
  return shutdownTask;
}
const control = setInterval(() => {
  if (existsSync(join(directory, "shutdown.request"))) {
    void shutdown().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}, 20);
control.unref();
childProcess.spawn = function (...args) {
  const child = Reflect.apply(actualSpawn, this, args);
  const receipt = { pid: child.pid ?? null, closed: false, errors: [], events: [] };
  const owner = { child, receipt };
  children.push(owner);
  child.on(errorMonitor, (error) => {
    receipt.errors.push(error.code ?? error.message);
    receipt.events.push("error");
  });
  child.once("exit", (code, signal) => {
    receipt.events.push("exit");
    receipt.exit = { code, signal };
  });
  child.once("close", (code, signal) => {
    receipt.events.push("close");
    receipt.closed = true;
    receipt.close = { code, signal };
  });
  return child;
};
syncBuiltinESMExports();
const { BackgroundShellManager, bashTool } = await import(
  pathToFileURL(process.env.CODESHELL_BG_LIFECYCLE_BUNDLE)
);
let passed = 0;
let failed = 0;
let resourceCounter = 0;
function backend(file, args) {
  let cleanups = 0;
  const resource = join(directory, "resource-" + ++resourceCounter);
  return {
    resource,
    get cleanups() {
      return cleanups;
    },
    sandbox: {
      name: "off",
      wrap() {
        mkdirSync(resource);
        return {
          file,
          args,
          cleanup() {
            cleanups++;
            rmSync(resource, { recursive: true, force: true });
          },
        };
      },
    },
  };
}
async function run(name, body) {
  test(name, { timeout: 5000 }, async () => {
    assert.equal(shuttingDown, false, "Fixture shutdown forbids new work");
    const manager = new BackgroundShellManager();
    managers.add(manager);
    try {
      await body(manager);
      passed++;
    } catch (error) {
      failed++;
      throw error;
    } finally {
      await manager.killAll();
      persist("progress.json", {
        passed,
        failed,
        children: children.map((owner) => owner.receipt),
      });
    }
  });
}
async function bash(manager, fixture, signal) {
  assert.equal(shuttingDown, false, "Fixture shutdown forbids new work");
  return await bashTool(
    { command: "fixture command", run_in_background: true },
    {
      cwd: home,
      sessionId: "fixture-session",
      backgroundShells: manager,
      sandbox: fixture.sandbox,
      signal,
    },
  );
}

await run(
  "missing executable returns a Bash failure without killing its Node parent",
  async (manager) => {
    const fixture = backend(join(directory, "missing-shell"), []);
    const result = await bash(manager, fixture);
    assert.equal(result.ok, false);
    assert.match(result.error, /Failed to spawn background shell/);
    const owner = children.at(-1);
    assert.equal(owner.receipt.pid, null);
    await waitFor(() => owner.receipt.closed);
    assert.deepEqual(owner.receipt.errors, ["ENOENT"]);
    assert.equal(fixture.cleanups, 1);
    assert.equal(existsSync(fixture.resource), false);
    assert.deepEqual(manager.list("fixture-session"), []);
  },
);
await run("non-executable shell returns EACCES and releases its backend once", async (manager) => {
  const path = join(directory, "not-executable");
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
  const fixture = backend(path, []);
  assert.equal((await bash(manager, fixture)).ok, false);
  const owner = children.at(-1);
  await waitFor(() => owner.receipt.closed);
  assert.deepEqual(owner.receipt.errors, ["EACCES"]);
  assert.equal(fixture.cleanups, 1);
});
await run(
  "synchronous spawn validation failure releases its backend exactly once",
  async (manager) => {
    const fixture = backend("invalid\0shell", []);
    const before = children.length;
    const result = await bash(manager, fixture);
    assert.equal(result.ok, false);
    assert.match(result.error, /Failed to spawn background shell/);
    assert.equal(children.length, before);
    assert.equal(fixture.cleanups, 1);
    assert.equal(existsSync(fixture.resource), false);
  },
);
await run(
  "natural nonzero exit preserves status and only releases after close",
  async (manager) => {
    const fixture = backend("/bin/sh", ["-c", "printf done; exit 7"]);
    assert.equal((await bash(manager, fixture)).ok, true);
    const owner = children.at(-1);
    let cleanupAtExit;
    owner.child.once("exit", () => {
      cleanupAtExit = fixture.cleanups;
    });
    await waitFor(() => owner.receipt.closed);
    assert.equal(cleanupAtExit, 0);
    assert.equal(fixture.cleanups, 1);
    const [shell] = manager.list("fixture-session");
    assert.equal(shell.status, "exited");
    assert.equal(shell.exitCode, 7);
    assert.equal(shell.signal, null);
    assert.match(manager.readOutput(shell.shellId, "all").text, /done/);
    await manager.kill(shell.shellId);
    assert.equal(fixture.cleanups, 1);
  },
);
await run(
  "a live child error does not release resources before inherited pipes close",
  async (manager) => {
    const fixture = backend("/bin/sh", [
      "-c",
      '(while [ ! -f "$1" ]; do sleep 0.01; done) & exit 0',
      "fixture",
      gate,
    ]);
    assert.equal((await bash(manager, fixture)).ok, true);
    const owner = children.at(-1);
    try {
      owner.child.emit("error", new Error("synthetic live-child error"));
      assert.equal(fixture.cleanups, 0);
      await waitFor(() => owner.receipt.events.includes("exit"));
      assert.equal(owner.receipt.closed, false);
      assert.equal(fixture.cleanups, 0);
    } finally {
      // Release even on an assertion failure so no detached descendant leaks.
      writeFileSync(gate, "release", { mode: 0o600 });
    }
    await waitFor(() => owner.receipt.closed);
    assert.equal(fixture.cleanups, 1);
  },
);
await run(
  "explicit kill preserves killed status and releases once on actual close",
  async (manager) => {
    const fixture = backend("/bin/sh", ["-c", "sleep 30 & wait"]);
    assert.equal((await bash(manager, fixture)).ok, true);
    const owner = children.at(-1);
    const [shell] = manager.list("fixture-session");
    assert.equal(fixture.cleanups, 0);
    assert.equal((await manager.kill(shell.shellId)).ok, true);
    await waitFor(() => owner.receipt.closed);
    assert.equal(fixture.cleanups, 1);
    assert.equal(manager.get(shell.shellId).status, "killed");
    assert.equal(manager.get(shell.shellId).signal, "SIGTERM");
    await manager.kill(shell.shellId);
    assert.equal(fixture.cleanups, 1);
  },
);
await run(
  "Run abort leaves background work alive until its owning session closes",
  async (manager) => {
    const controller = new AbortController();
    const fixture = backend("/bin/sh", ["-c", "sleep 30 & wait"]);
    assert.equal((await bash(manager, fixture, controller.signal)).ok, true);
    const owner = children.at(-1);
    controller.abort();
    assert.equal(manager.list("fixture-session")[0].status, "running");
    assert.equal(owner.receipt.closed, false);
    assert.equal(fixture.cleanups, 0);
    await manager.killSession("fixture-session");
    await waitFor(() => owner.receipt.closed);
    assert.equal(fixture.cleanups, 1);
  },
);
await run(
  "cooperative fixture shutdown waits for its live background child to close",
  async (manager) => {
    const fixture = backend("/bin/sh", ["-c", "sleep 30 & wait"]);
    assert.equal((await bash(manager, fixture)).ok, true);
    const owner = children.at(-1);
    assert.equal(owner.receipt.closed, false);
    writeFileSync(join(directory, "shutdown.request"), "shutdown", { mode: 0o600 });
    await waitFor(() => shutdownTask !== undefined);
    assert.equal(await shutdownTask, true);
    assert.equal(owner.receipt.closed, true);
    assert.equal(fixture.cleanups, 1);
  },
);
after(async () => {
  const complete = await shutdown();
  clearInterval(control);
  persist("completion.json", {
    tests: 8,
    passed,
    failed,
    unexpectedNetworkCalls: denied - 8,
    pid: process.pid,
    ppid: process.ppid,
    children: children.map((owner) => owner.receipt),
  });
  assert.equal(denied, 8);
  assert.equal(complete, true);
  assert.ok(children.every((owner) => owner.receipt.closed));
});

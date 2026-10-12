import assert from "node:assert/strict";
import fs from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { syncBuiltinESMExports } from "node:module";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import childProcess from "node:child_process";

const ownedSpawn = childProcess.spawn.bind(childProcess);
const denied = () => {
  throw new Error("Controller cut fixture refuses all transports and product processes.");
};
globalThis.fetch = denied;
http.request = http.get = https.request = https.get = denied;
net.connect = net.createConnection = tls.connect = denied;
net.Socket.prototype.connect = denied;
for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
  childProcess[key] = denied;
syncBuiltinESMExports();
const home = fs.realpathSync(process.env.HOME);
assert.equal(home, process.env.HOME);
assert.ok(home.includes("codeshell-bun-completion-"));
const entry = process.argv[2];
const inside = relative(home, entry);
assert.ok(inside && !inside.startsWith("..") && !isAbsolute(inside));
const { acquireProjectControllerLock } = await import(entry);
const report = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

if (process.argv[3] === "--owner") {
  const [control, barrier, ready] = process.argv.slice(4);
  for (let wait = 0; !fs.existsSync(barrier); wait++) {
    if (wait === 500) throw new Error("Owned cut controller acquisition timed out.");
    await delay(10);
  }
  const lease = acquireProjectControllerLock(control);
  lease.assertHeld();
  fs.writeFileSync(
    ready,
    JSON.stringify({ pid: process.pid, ino: fs.lstatSync(control + ".lock").ino }),
    { mode: 0o600, flag: "wx" },
  );
  try {
    for await (const line of createInterface({ input: process.stdin })) {
      if (line !== "check") throw new Error("Unknown owned controller cut command.");
      lease.assertHeld();
      report({ held: true });
    }
  } finally {
    lease.release();
    process.stdin.destroy();
  }
} else {
  const results = [];
  for (const scenario of ["release", "stale-reclaim"]) {
    console.error(`Controller syscall cut: ${scenario}: starting`);
    const root = fs.mkdtempSync(join(home, "native-controller-cut-"));
    const control = join(root, "project-control"),
      lockPath = control + ".lock",
      barrier = join(root, "acquire"),
      ready = join(root, "ready.json");
    fs.mkdirSync(control, { mode: 0o700 });
    let first;
    if (scenario === "release") first = acquireProjectControllerLock(control);
    else {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      const stale = new Date(Date.now() - 60_000);
      fs.utimesSync(lockPath, stale, stale);
    }
    const child = ownedSpawn(
      process.execPath,
      [fileURLToPath(import.meta.url), entry, "--owner", control, barrier, ready],
      { env: process.env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let exited = false,
      stderr = "";
    const ended = new Promise((done) =>
      child.once("close", (code, signal) => {
        exited = true;
        done({ code, signal });
      }),
    );
    // A bounded test timeout may terminate this helper, but its exact captured
    // descendant must exit before the fixture can remove the private HOME.
    const terminate = () => child.kill("SIGKILL");
    process.once("SIGTERM", terminate);
    child.stderr.on("data", (part) => (stderr = (stderr + part).slice(-4000)));
    const originalRmdir = fs.rmdirSync;
    let cutReached = false,
      replacement,
      operationError;
    try {
      fs.rmdirSync = function (path, ...args) {
        if (path === lockPath && !cutReached) {
          cutReached = true;
          fs.renameSync(path, path + ".retired");
          fs.writeFileSync(barrier, "1\n", { mode: 0o600, flag: "wx" });
          const waitUntil = Date.now() + 5000;
          // The other owner is a separate native Node process. Wait at the
          // exact sync syscall cut without relying on this event loop's IPC.
          while (!fs.existsSync(ready)) {
            if (Date.now() >= waitUntil) throw new Error("Replacement owner receipt timed out.");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
          const receipt = JSON.parse(fs.readFileSync(ready, "utf8"));
          assert.equal(receipt.pid, child.pid);
          replacement = fs.lstatSync(path);
          assert.equal(receipt.ino, replacement.ino);
          console.error(`Controller syscall cut: ${scenario}: replacement ready`);
        }
        return originalRmdir.call(this, path, ...args);
      };
      syncBuiltinESMExports();
      try {
        if (first) first.release();
        else first = acquireProjectControllerLock(control);
      } catch (error) {
        operationError = error.message;
      } finally {
        fs.rmdirSync = originalRmdir;
        syncBuiltinESMExports();
      }
      assert.ok(cutReached, "actual rmdir syscall cut must execute");
      const preserved = fs.existsSync(lockPath) && fs.lstatSync(lockPath).ino === replacement.ino;
      console.error(`Controller syscall cut: ${scenario}: preserved=${preserved}`);
      let healthyHeartbeat = false,
        markerPreserved = false;
      if (preserved) {
        const names = fs.readdirSync(lockPath);
        markerPreserved = names.length === 1 && /^\.owner-[a-f0-9-]{36}$/.test(names[0]);
        if (scenario === "release") {
          const before = fs.lstatSync(lockPath).mtimeMs;
          await delay(10_250);
          healthyHeartbeat = fs.lstatSync(lockPath).mtimeMs > before;
          console.error(`Controller syscall cut: ${scenario}: heartbeat=${healthyHeartbeat}`);
        }
        const answer = new Promise((done) => child.stdout.once("data", done));
        child.stdin.write("check\n");
        const value = await Promise.race([
          answer,
          ended.then(() => {
            throw new Error(`Replacement owner lost custody: ${stderr}`);
          }),
          delay(5000).then(() => {
            throw new Error("Replacement owner check timed out.");
          }),
        ]);
        assert.deepEqual(JSON.parse(String(value)), { held: true });
        console.error(`Controller syscall cut: ${scenario}: held`);
      }
      child.stdin.end();
      const result = await Promise.race([
        ended,
        delay(5000).then(() => {
          throw new Error("Replacement owner close timed out.");
        }),
      ]);
      assert.deepEqual(result, { code: 0, signal: null }, stderr);
      console.error(`Controller syscall cut: ${scenario}: child exited`);
      const independentlyClosed = !fs.existsSync(lockPath);
      results.push({
        scenario,
        cutReached,
        preserved,
        markerPreserved,
        healthyHeartbeat,
        independentlyClosed,
        operationError,
        ownedChildExited: exited,
      });
    } finally {
      process.removeListener("SIGTERM", terminate);
      fs.rmdirSync = originalRmdir;
      syncBuiltinESMExports();
      if (!exited) {
        child.kill("SIGKILL");
        await ended;
      }
      first?.release();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  report({ nativeNode: process.version, noExternalNetwork: true, results });
}

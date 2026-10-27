import { equal } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBunTestEnvironment } from "../../../scripts/bun-test-completion.mjs";

test(
  "operation-read confinement permits only the watchdog's fixed process metadata query",
  { skip: process.platform === "win32" ? "POSIX process metadata query" : false },
  (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "operation-watchdog-guard-test-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const environment = createBunTestEnvironment(process.env, root);
    environment.CODESHELL_COST_SMOKE_ORIGIN = "http://127.0.0.1:9";
    environment.CODESHELL_COST_SMOKE_HOME_ID = createHash("sha256")
      .update(environment.HOME)
      .digest("hex");
    writeFileSync(join(environment.HOME, "operation-read-source.json"), "{}", { mode: 0o600 });
    const source = `
import assert from "node:assert/strict";
import children from "node:child_process";
import { snapshotElectronTestProcessesAsync } from ${JSON.stringify(new URL("./electron-test-process-snapshot.mjs", import.meta.url).href)};
import { watchElectronTestProcess } from ${JSON.stringify(new URL("./electron-test-watchdog.mjs", import.meta.url).href)};
await import(${JSON.stringify(new URL("./operation-read-guard.mjs", import.meta.url).href)});
const processes = children.execFileSync("/bin/ps", ["-axo", "pid=,ppid=,lstart="], {
  env: { PATH: "/invalid", LC_ALL: "invalid" },
});
assert.equal(typeof processes, "string");
assert.equal(processes.split(String.fromCharCode(10)).some((line) =>
  Number(line.trim().split(" ").filter(Boolean)[0]) === process.pid), true);
assert.throws(() => children.execFileSync("/bin/ps", ["eww"]), /refused external child/);
assert.throws(() => children.spawn("/bin/ps", ["-axo", "pid=,ppid=,lstart="]), /refused external child/);
assert.throws(() => children.execFileSync("/bin/ps", ["-axo", "command="]), /refused external child/);
assert.throws(() => children.execFile("/bin/ps", ["eww"], () => {}), /refused external child/);
assert.throws(() => children.execFile("/bin/ps", ["-axo", "command="], () => {}), /refused external child/);
assert.throws(() => children.exec("/bin/ps -axo pid=,ppid=,lstart="), /refused shell child/);
// Imports deliberately precede the guard: syncBuiltinESMExports also patches
// the snapshot module's named async execFile binding in the real controller.
const snapshot = await snapshotElectronTestProcessesAsync();
assert.equal(snapshot.some((row) => row.pid === process.pid && row.ppid === process.ppid), true);
for (const options of [undefined, { env: { PATH: "/invalid", LC_ALL: "invalid" }, shell: true, cwd: "/invalid" }]) {
  const output = await new Promise((resolve, reject) => {
    const callback = (error, stdout) => error ? reject(error) : resolve(stdout);
    const args = ["/bin/ps", ["-axo", "pid=,ppid=,lstart="]];
    children.execFile(...args, ...(options ? [options, callback] : [callback]));
  });
  assert.equal(typeof output, "string");
}
const child = children.spawn(process.execPath, ["-e", "process.stdin.on('end', () => process.exit(0)); process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
const exited = new Promise((resolve) => child.once("exit", resolve));
await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
let tick;
const failures = [];
const monitor = watchElectronTestProcess(child, {
  setInterval(callback) { tick = callback; return 0; },
  clearInterval() {},
  reportFailure(message) { failures.push(message); },
});
try {
  for (let poll = 0; poll < 3; poll++) {
    const count = monitor.snapshotTiming.count;
    tick();
    const deadline = Date.now() + 5000;
    while (monitor.snapshotTiming.count === count && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(monitor.snapshotTiming.count, count + 1);
  }
  assert.deepEqual(failures, []);
} finally {
  child.stdin.end();
  await exited;
  const evidence = await monitor.completed;
  assert.equal(evidence.status, "cleaned");
  assert.equal(evidence.queryFailed, false);
  assert.equal(evidence.remainingCount, 0);
}
process.stdout.write("fixed sync/async process metadata allowed; watchdog cleanup verified; other ps modes refused\\n");
`;
    const child = spawnSync(
      process.versions.bun ? "node" : process.execPath,
      ["--input-type=module", "-e", source],
      { env: environment, encoding: "utf8", timeout: 10_000 },
    );
    equal(child.status, 0, child.stderr);
    equal(
      child.stdout,
      "fixed sync/async process metadata allowed; watchdog cleanup verified; other ps modes refused\n",
    );
  },
);

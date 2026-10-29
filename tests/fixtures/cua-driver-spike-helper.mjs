// Simulate the CLI bridge and Helper.app as one process. This exercises the
// runtime's helper -> embedded daemon contract, not LaunchServices or macOS TCC.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [command, mode, socketOption, socketPath] = process.argv.slice(2);
assert.equal(command, "launch");
assert.equal(mode, "serve");
assert.equal(socketOption, "--socket");
assert.ok(socketPath);
const record = (event) =>
  appendFileSync(
    join(dirname(socketPath), "events.jsonl"),
    JSON.stringify({ mode: "helper", pid: process.pid, ppid: process.ppid, ...event }) + "\n",
  );
record({ phase: "started", secretInherited: "CODESHELL_CUA_TEST_SECRET" in process.env });

const environment = {};
for (const key of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR"]) {
  if (typeof process.env[key] === "string") environment[key] = process.env[key];
}
environment.CUA_DRIVER_EMBEDDED = "1";
environment.CUA_DRIVER_HOST_BUNDLE_ID = "com.cjhyy.codeshell.computer-use";
environment.CUA_DRIVER_PERMISSION_MODE = "standard";
environment.CUA_DRIVER_PARENT_LIVENESS_STDIN = "1";
const driver = spawn(
  join(dirname(process.argv[1]), "../Resources/cua-driver"),
  ["serve", "--embedded", "--socket", socketPath],
  { env: environment, stdio: ["pipe", "inherit", "inherit"] },
);
let stopping = false;
driver.once("error", (error) => {
  console.error(error);
  process.exit(1);
});
driver.once("exit", (code, signal) => {
  record({ phase: "driver-exited", code, signal });
  process.exit(stopping ? 0 : (code ?? 1));
});
process.on("SIGTERM", () => {
  stopping = true;
  driver.stdin.end();
});

// Builtin-only actual Node negative control; the captured child has no Core or network.
import assert from "node:assert/strict";
import children from "node:child_process";
import { once } from "node:events";
import { realpathSync } from "node:fs";

const child = new children.ChildProcess();
const node = realpathSync(process.execPath);
let refused = false;
try {
  child.spawn({
    file: node,
    args: [
      node,
      "--input-type=module",
      "-e",
      "console.log(JSON.stringify({guarded:!!globalThis[Symbol.for('codeshell.docker-candidate.pre-core')]}))",
    ],
    cwd: process.env.HOME,
    envPairs: [`HOME=${process.env.HOME}`, "NODE_OPTIONS="],
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  assert.match(error.message, /Docker candidate refused/);
  refused = true;
}
if (!refused) {
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (bytes) => (stdout += bytes));
  child.stderr.on("data", (bytes) => (stderr += bytes));
  const [code, signal] = await once(child, "close");
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
  assert.equal(JSON.parse(stdout).guarded, false);
  assert.fail("Direct ChildProcess.spawn ran a child without the pre-Core guard");
}
console.log("PASS refused direct native spawn");

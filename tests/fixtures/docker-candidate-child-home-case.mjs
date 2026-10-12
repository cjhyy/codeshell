// Builtin-only private-HOME regression. The child entry is digest-pinned and
// imports only builtins after its own policy/preload has completed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG));
const descriptor = config.children[0];
const env = { ...descriptor.environment };
if (config.testChildUnregisteredHome) env.HOME = config.home;
const launch = () =>
  spawn(descriptor.path, descriptor.args, {
    cwd: descriptor.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
if (config.testChildExpectedRefusal) {
  assert.throws(launch, /Docker candidate refused/);
  console.log("PASS refused child HOME");
} else {
  const child = launch();
  let output = "",
    errors = "";
  child.stdout.on("data", (bytes) => (output += bytes));
  child.stderr.on("data", (bytes) => (errors += bytes));
  const [code, signal] = await once(child, "close");
  assert.equal(code, 0, errors);
  assert.equal(signal, null);
  assert.equal(output.trim(), "child guarded");
  console.log("PASS independent child HOME");
}

// Builtin-only actual Node regression; no Core, network or subprocess executes.
import assert from "node:assert/strict";
import workers, { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { once } from "node:events";

const require = createRequire(import.meta.url);
const source = `const { parentPort } = require('node:worker_threads');
parentPort.postMessage({ guarded: !!globalThis[Symbol.for('codeshell.docker-candidate.pre-core')] });`;
for (const Constructor of [workers.Worker, Worker, require("node:worker_threads").Worker]) {
  let child;
  try {
    child = new Constructor(source, {
      eval: true,
      execArgv: [],
      env: { HOME: process.env.HOME, NODE_OPTIONS: "" },
    });
  } catch (error) {
    assert.match(error.message, /Docker candidate refused/);
    continue;
  }
  // On the old guard this reaches a real Worker with no inherited preload.
  // Close that exact Worker before rejecting the failed protection contract.
  try {
    const [message] = await once(child, "message");
    assert.equal(message.guarded, false);
    assert.fail("Unreviewed Worker entry ran without the pre-Core guard");
  } finally {
    await child.terminate();
  }
}
console.log("PASS refused unreviewed Worker constructors");

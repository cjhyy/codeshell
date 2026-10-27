import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { stopSmokeProcess } from "./fixtures/hub-smoke-lifecycle.mjs";

assert.ok(process.env.CODE_SHELL_TEST_HOME, "Run through run-isolated-node-smoke.mjs");
const children = new Set();
async function start(exitCode) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `process.on("message", () => { ${exitCode === null ? "" : `process.exit(${exitCode});`} });
       process.send("ready");`,
    ],
    { stdio: ["ignore", "ignore", "inherit", "ipc"], env: process.env },
  );
  children.add(child);
  child.once("exit", () => children.delete(child));
  await once(child, "message");
  return child;
}
const requestStop = (child) => () => child.send("stop");
try {
  const graceful = await start(0);
  await stopSmokeProcess(graceful, { requestStop: requestStop(graceful) });
  const failed = await start(2);
  await assert.rejects(
    stopSmokeProcess(failed, { requestStop: requestStop(failed) }),
    /must exit successfully/,
  );
  const stalled = await start(null);
  await assert.rejects(
    stopSmokeProcess(stalled, { timeoutMs: 50, requestStop: requestStop(stalled) }),
    /required a forced kill/,
  );
  assert.equal(stalled.signalCode, "SIGKILL");
  const cleanup = await start(null);
  await stopSmokeProcess(cleanup, {
    cleanup: true,
    timeoutMs: 50,
    requestStop: requestStop(cleanup),
  });
  const killFailure = await start(null);
  await assert.rejects(
    stopSmokeProcess(killFailure, {
      timeoutMs: 50,
      requestStop: requestStop(killFailure),
      forceStop: () => {
        throw new Error("Synthetic cleanup failure");
      },
    }),
    /Synthetic cleanup failure/,
  );
  const exited = once(killFailure, "exit");
  killFailure.kill("SIGKILL");
  await exited;
  assert.equal(children.size, 0);
  console.log(
    "PASS: successful shutdown, failed exit, forced-kill rejection and reported cleanup failures",
  );
} finally {
  await Promise.all([...children].map((child) => stopSmokeProcess(child, { cleanup: true })));
}

import assert from "node:assert/strict";
import { once } from "node:events";

/** A forced cleanup is never evidence that the production shutdown succeeded. */
export async function stopSmokeProcess(
  child,
  {
    cleanup = false,
    timeoutMs = 10_000,
    requestStop = () => child.kill("SIGTERM"),
    forceStop = () => child.kill("SIGKILL"),
  } = {},
) {
  if (child.exitCode !== null || child.signalCode !== null) {
    if (cleanup) return;
    throw new Error("Hub exited before graceful shutdown was requested");
  }
  const exited = once(child, "exit");
  let failForcedStop;
  const forceFailed = new Promise((_, reject) => {
    failForcedStop = reject;
  });
  const completion = Promise.race([exited, forceFailed]);
  let forced = false;
  const timer = setTimeout(() => {
    forced = true;
    try {
      forceStop();
    } catch (error) {
      failForcedStop(error);
    }
  }, timeoutMs);
  try {
    requestStop();
    const [code, signal] = await completion;
    if (!cleanup) {
      assert.equal(forced, false, "Hub graceful shutdown timed out and required a forced kill");
      assert.equal(signal, null, `Hub shutdown was interrupted by ${signal}`);
      assert.equal(code, 0, "Hub shutdown must exit successfully");
    }
  } finally {
    clearTimeout(timer);
  }
}

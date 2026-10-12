import assert from "node:assert/strict";
import WebSocket from "ws";

/** Packaged Electron filters NODE_OPTIONS/CLI --require. Require the private
 * fixture guard at the owned executable's first-JavaScript inspector pause.
 * A late pause, foreign endpoint or failed require must never resume the app.
 */
export async function preloadPausedPackagedMain(
  child,
  bootstrap,
  { allowedPause, isHostScript, timeoutMs = 15_000, allowParsedHostOnStart = false } = {},
) {
  let socket;
  let timer;
  let stderr = "";
  let sequence = 0;
  let resumed = false;
  const pending = new Map();
  const scripts = new Map();
  let onData;
  let onExit;
  let fail;
  let resolvePause;
  const pause = new Promise((resolve) => {
    resolvePause = resolve;
  });
  const failure = new Promise((_, reject) => {
    fail = reject;
  });
  failure.catch(() => {});
  const bounded = (operation) => Promise.race([operation, failure]);
  const send = (method, params = {}) =>
    bounded(
      new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      }),
    );
  try {
    timer = setTimeout(
      () => fail(Error("owned packaged startup pause/preload timed out")),
      timeoutMs,
    );
    const inspector = new Promise((resolve) => {
      onData = (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-16_384);
        const match = stderr.match(/Debugger listening on (ws:\/\/[^\s]+)/);
        if (match) resolve(match[1]);
      };
      child.stderr.on("data", onData);
      onExit = () => fail(Error("owned packaged Main exited before startup preload completed"));
      child.once("exit", onExit);
    });
    const endpoint = new URL(await bounded(inspector));
    assert.equal(endpoint.protocol, "ws:");
    assert.equal(endpoint.hostname, "127.0.0.1");
    assert.ok(endpoint.port && !endpoint.username && !endpoint.password);
    socket = new WebSocket(endpoint);
    socket.on("error", fail);
    socket.on("close", () => fail(Error("owned startup inspector closed prematurely")));
    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.id) {
          const waiting = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) waiting?.reject(Error(JSON.stringify(message.error)));
          else waiting?.resolve(message.result);
        } else if (message.method === "Debugger.scriptParsed")
          scripts.set(message.params.scriptId, message.params.url);
        else if (message.method === "Debugger.paused") resolvePause(message.params);
      } catch (error) {
        fail(error);
      }
    });
    await bounded(new Promise((resolve) => socket.once("open", resolve)));
    await send("Runtime.enable");
    await send("Debugger.enable");
    await send("Runtime.runIfWaitingForDebugger");
    const paused = await bounded(pause);
    const top = paused.callFrames[0];
    const url = top?.url || scripts.get(top?.location.scriptId);
    assert.equal(
      paused.reason,
      "Break on start",
      "startup guard requires the runtime's initial pause",
    );
    assert.ok(
      allowedPause(url, paused),
      `startup pause is outside the permitted pre-Host boundary: ${url}`,
    );
    const hostScripts = [...scripts.values()].filter(isHostScript);
    if (!allowParsedHostOnStart)
      assert.equal(
        hostScripts.length,
        0,
        "official Host modules were parsed before guard installation",
      );
    const { scriptSource } = await send("Debugger.getScriptSource", {
      scriptId: top.location.scriptId,
    });
    const result = await send("Runtime.evaluate", {
      expression: `require(${JSON.stringify(bootstrap)}); "guard-installed"`,
      includeCommandLineAPI: true,
      returnByValue: true,
    });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    assert.equal(result.result.value, "guard-installed");
    const receipt = {
      pid: child.pid,
      method: "inspect-brk first-JavaScript pause, synchronous CJS require, then resume",
      pauseURL: url,
      reason: paused.reason,
      hostScriptsParsedBeforeGuard: hostScripts.length,
      pausedLocation: top.location,
      firstUserInstruction: true,
      sourcePrefix: scriptSource.slice(0, 250),
    };
    await send("Debugger.resume");
    resumed = true;
    return receipt;
  } catch (error) {
    // Disconnecting the last inspector can resume a paused VM. Terminate only
    // this captured child before disconnecting on any failed startup barrier.
    const errors = [error];
    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (child.exitCode === null && child.signalCode === null)
          throw Error("captured startup child still alive; inspector and HOME retained", {
            cause: error,
          });
      }
    } catch (closeError) {
      errors.push(closeError);
    }
    throw new AggregateError(errors, "owned packaged startup barrier failed", { cause: error });
  } finally {
    clearTimeout(timer);
    if (onData) child.stderr.removeListener("data", onData);
    if (onExit) child.removeListener("exit", onExit);
    if (resumed || child.exitCode !== null || child.signalCode !== null) socket?.close();
    for (const waiting of pending.values()) waiting.reject(Error("startup inspector disposed"));
  }
}

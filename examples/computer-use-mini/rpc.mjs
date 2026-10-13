import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export function createRpcClient({ trace = () => {}, timeoutMs = 3_000 } = {}) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./executor.mjs", import.meta.url))],
    {
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  const input = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let nextId = 0;
  let stopped;
  const exited = new Promise((resolve) => child.once("close", resolve));

  function rejectPending(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }

  function stop(error) {
    stopped ??= error;
    rejectPending(stopped);
    child.kill();
  }

  child.on("error", stop);
  child.stdin.on("error", stop);
  child.stdout.on("error", stop);
  child.once("exit", (code, signal) => {
    stopped ??= new Error(`Executor exited (${signal ?? code})`);
    rejectPending(stopped);
  });
  input.once("close", () => {
    if (!stopped) stop(new Error("Executor output closed"));
  });
  input.on("line", (line) => {
    try {
      const response = JSON.parse(line);
      if (response.jsonrpc !== "2.0") throw new Error("Invalid executor response");
      trace("←", response);
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      clearTimeout(request.timer);
      if (response.error) request.reject(new Error(response.error.message));
      else request.resolve(response.result);
    } catch (error) {
      stop(error);
    }
  });

  return {
    call(method, params = {}) {
      if (stopped) return Promise.reject(stopped);
      const id = ++nextId;
      const message = { jsonrpc: "2.0", id, method, params };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          // Stop the transport and reject pending calls; completed actions are not undone.
          stop(new Error(`RPC timed out: ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        trace("→", message);
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error) stop(error);
        });
      });
    },
    async close() {
      if (!stopped) {
        stopped = new Error("RPC client closed");
        rejectPending(stopped);
        child.stdin.end();
      }
      const timer = setTimeout(() => child.kill(), 250);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
        input.close();
      }
    },
  };
}

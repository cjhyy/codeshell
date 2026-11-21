import { WorkerBridgeCore } from "@cjhyy/code-shell-server/worker";
import { parseWorkerLine, type ParsedWorkerLine } from "../worker-line.js";
import type { WorkerCommand, WorkerNotice, WorkerPort } from "./worker-wire.js";

/** One stdio executor lives and dies with this particular utility generation. */
export function bindHostWorker(
  port: WorkerPort,
  launch: { execPath: string; entryPath: string },
  observers: {
    observeWorkerLine?(line: ParsedWorkerLine): void;
    workerExited?(generation: number): void;
  } = {},
) {
  let active = true;
  let generation = 0;
  let env: NodeJS.ProcessEnv = {};
  const post = (message: WorkerNotice) => {
    if (!active) return;
    try {
      port.postMessage(message);
    } catch {
      void close();
    }
  };
  const core = new WorkerBridgeCore({
    ...launch,
    buildEnv: () => env,
    onWorkerStarted: ({ pid }) => post({ type: "started", generation, pid }),
    onSpawnFailed: () => post({ type: "spawn-failed", generation }),
    onSpawnError: (error) => post({ type: "spawn-failed", generation, message: String(error) }),
    onExit: (info) => {
      try {
        observers.workerExited?.(generation);
      } finally {
        post({ type: "exit", generation, info });
      }
    },
    onStderr: (text) => post({ type: "stderr", generation, text }),
  });
  core.subscribeLines((line) => {
    try {
      observers.observeWorkerLine?.(parseWorkerLine(line));
    } finally {
      post({ type: "line", generation, line });
    }
  });
  let closing: Promise<void> | undefined;
  function close() {
    if (closing) return closing;
    active = false;
    closing = core.stopAndWait();
    port.close();
    return closing;
  }
  port.on("close", () => {
    void close();
  });
  port.on("message", ({ data, ports }) => {
    for (const foreign of ports) foreign.close();
    if (ports.length || !active || !data || typeof data !== "object") return;
    const message = data as WorkerCommand;
    if (!Number.isSafeInteger(message.generation)) return;
    if (message.type === "start") {
      if (
        core.hasChild() ||
        message.generation <= generation ||
        typeof message.cwd !== "string" ||
        !message.env ||
        typeof message.env !== "object"
      )
        return;
      generation = message.generation;
      env = { ...message.env, ELECTRON_RUN_AS_NODE: "1", CODESHELL_AGENT_STDIO: "1" };
      core.ensureWorker(message.cwd);
      return;
    }
    if (message.type === "request") {
      if (message.generation !== generation) {
        post({ type: "result", call: message.call, outcome: { status: "sendFailed" } });
        return;
      }
      void core
        .request(message.method, message.params, { ...message.options, ensureWorker: false })
        .then((outcome) => post({ type: "result", call: message.call, outcome }));
    } else if (message.generation === generation) {
      if (message.type === "stop") core.kill();
      else if (message.type === "write" && typeof message.line === "string")
        core.sendLine(message.line);
    }
  });
  port.start();
  return { close };
}

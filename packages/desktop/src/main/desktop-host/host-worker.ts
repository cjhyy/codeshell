import type { HostOutput } from "./host-output.js";
import type { OutputPublication } from "./stored-output.js";
import { WorkerBridgeCore } from "@cjhyy/code-shell-server/worker";
import { parseWorkerLine, type ParsedWorkerLine } from "../worker-line.js";
import type { WorkerCommand, WorkerNotice, WorkerPort } from "./worker-wire.js";

/** One stdio executor lives and dies with this particular utility generation. */
export function bindHostWorker(
  port: WorkerPort,
  launch: { execPath: string; entryPath: string },
  observers: {
    output?: HostOutput;
    observeWorkerLine?(line: ParsedWorkerLine): void;
    workerExited?(generation: number): void;
  } = {},
) {
  let active = true;
  let generation = 0;
  let allDeltas = false;
  let deltaSessions = new Set<string>();
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
        later({ type: "exit", generation, info });
      }
    },
    onStderr: (text) => post({ type: "stderr", generation, text }),
  });
  const later = (message: WorkerNotice) => {
    if (observers.output) void observers.output.drain().then(() => post(message));
    else post(message);
  };
  core.subscribeLines((line) => {
    const parsed = parseWorkerLine(line);
    const realStream =
      (parsed.message as { method?: string } | null)?.method === "agent/streamEvent";
    try {
      observers.observeWorkerLine?.(parsed);
    } finally {
      if (realStream && observers.output) observers.output.push(line);
      else later({ type: "line", generation, line });
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
    if (message.type === "delta-interest") {
      allDeltas = message.all;
      deltaSessions = new Set(message.sessions);
      return;
    }
    if (message.type === "output" || message.type === "snapshot") {
      const output = observers.output;
      if (!output) {
        post({ type: "output-result", call: message.call, error: "Desktop output unavailable" });
        return;
      }
      const job =
        message.type === "snapshot"
          ? output.snapshot(message.sessionId, message.sinceSeq)
          : output.mutate(message.command);
      void job.then(
        (snapshot) =>
          post({ type: "output-result", call: message.call, ...(snapshot ? { snapshot } : {}) }),
        (error) => post({ type: "output-result", call: message.call, error: String(error) }),
      );
      return;
    }
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
        .then((outcome) => later({ type: "result", call: message.call, outcome }));
    } else if (message.generation === generation) {
      if (message.type === "stop") core.kill();
      else if (message.type === "write" && typeof message.line === "string")
        core.sendLine(message.line);
    }
  });
  port.start();
  return {
    close,
    pauseOutput: (paused: boolean) => core.pauseOutput(paused),
    publish(frames: OutputPublication[]) {
      const observed = frames.filter(({ envelope }) => {
        if (allDeltas || deltaSessions.has(envelope.sessionId)) return true;
        const type = (envelope.event as { type?: string } | null)?.type;
        return type !== "text_delta" && type !== "thinking_delta" && type !== "tool_use_delta";
      });
      if (observed.length) post({ type: "frames", frames: observed });
    },
  };
}

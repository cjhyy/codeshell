import { isRootMigrationReply } from "../../shared/project-migration.js";
import type { PetProjectionSnapshotResult } from "@cjhyy/code-shell-pet";
import { prepareAgentRunMetadata } from "../agent-run-metadata.js";
import { rendererRunFactReader } from "./renderer-run-facts.js";
import { WorkerCommandError } from "./server.js";
import type { WorkbenchAdmission, WorkbenchRequest } from "./ingress-wire.js";
import { WorkerRunOperations } from "./worker-run-operations.js";
import type { HostRunOperations } from "../../host/composition/run-operations.js";
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
    runOperations?: HostRunOperations;
    observeWorkerLine?(line: ParsedWorkerLine): void;
    workerExited?(generation: number): void;
    petProjection?: {
      observe(line: ParsedWorkerLine): boolean;
      workerState(generation: number, state: "active" | "disconnected" | "reclaimed"): void;
    };
  } = {},
) {
  let active = true;
  let generation = 0;
  let nextAdmission = 0;
  const admissions = new Map<
    number,
    { finish(value: WorkbenchAdmission): void; fail(error: Error): void }
  >();
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
  const runs =
    observers.runOperations &&
    new WorkerRunOperations(observers.runOperations, () => active && core.hasLiveWorker());
  const core: WorkerBridgeCore = new WorkerBridgeCore({
    ...(runs && {
      onOperationDisconnect: () => runs.close(),
      operationLedger: (req, current) => runs.run(req, current),
    }),
    ...launch,
    buildEnv: () => env,
    onWorkerStarted: ({ pid }) => {
      post({ type: "started", generation, pid });
      observers.petProjection?.workerState(generation, "active");
    },
    onSpawnFailed: () => {
      post({ type: "spawn-failed", generation });
      observers.petProjection?.workerState(generation, "disconnected");
    },
    onSpawnError: (error) => {
      post({ type: "spawn-failed", generation, message: String(error) });
      observers.petProjection?.workerState(generation, "disconnected");
    },
    onExit: (info) => {
      runs?.close();
      try {
        observers.workerExited?.(generation);
        observers.petProjection?.workerState(generation, info.clean ? "reclaimed" : "disconnected");
      } finally {
        const ended = generation;
        if (observers.output)
          void observers.output.mutate({ type: "worker-exit" }).then(
            () => post({ type: "exit", generation: ended, info }),
            () => {},
          );
        else post({ type: "exit", generation: ended, info });
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
    if (isRootMigrationReply(parsed.message)) return;
    if (observers.petProjection?.observe(parsed)) return;
    runs?.observe(parsed.message);
    const method = (parsed.message as { method?: string } | null)?.method;
    try {
      observers.observeWorkerLine?.(parsed);
    } finally {
      if (method === "agent/streamEvent" && observers.output) observers.output.push(line);
      else if (typeof method === "string" && method.startsWith("desktop/"))
        post({ type: "line", generation, line });
      else later({ type: "line", generation, line });
    }
  });
  function nativeAdmission(request: WorkbenchRequest) {
    const call = ++nextAdmission;
    return new Promise<WorkbenchAdmission>((resolve, reject) => {
      const timer = setTimeout(() => {
        admissions.delete(call);
        reject(new Error("Agent admission timed out"));
      }, 30_000).unref();
      admissions.set(call, {
        finish(value) {
          clearTimeout(timer);
          admissions.delete(call);
          resolve(value);
        },
        fail(error) {
          clearTimeout(timer);
          admissions.delete(call);
          reject(error);
        },
      });
      post({ type: "renderer-prepare", call, request });
    });
  }
  let closing: Promise<void> | undefined;
  function close() {
    if (closing) return closing;
    active = false;
    for (const pending of admissions.values()) pending.fail(new Error("Desktop Host was closed"));
    admissions.clear();
    runs?.close();
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
    if (message.type === "renderer-admitted") {
      admissions.get(message.call)?.finish(message.admission);
      return;
    }
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
      env = {
        ...message.env,
        CODE_SHELL_PRIVATE_LEDGER: runs ? "host" : undefined,
        ELECTRON_RUN_AS_NODE: "1",
        CODESHELL_AGENT_STDIO: "1",
      };
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
      if (message.type === "stop") {
        runs?.close();
        core.kill();
      } else if (message.type === "write" && typeof message.line === "string")
        core.sendLine(message.line);
    }
  });
  port.start();
  return {
    close,
    hasLiveWorker: () => active && core.hasLiveWorker(),
    async petProjectionSnapshot() {
      if (!active || !core.hasLiveWorker()) return null;
      const result = await core.request("agent/getPetProjectionSnapshot", undefined, {
        id: "mimi-projection:" + ++nextAdmission,
        timeoutMs: 5_000,
        consume: true,
        failFast: true,
        settleOnExit: true,
        meta: { origin: "host", producer: "pet-projection-snapshot" },
      });
      return result.status === "result" ? (result.result as PetProjectionSnapshotResult) : null;
    },
    async rendererCommand(request: WorkbenchRequest, current: () => void): Promise<unknown> {
      current();
      if (!active || admissions.size >= 128) throw new Error("Agent admission is unavailable");
      // These controls operate solely on the actual worker. The port grant
      // already binds their session, including approvals during a busy Main.
      const local =
        core.canSend() &&
        [
          "agent/approve",
          "agent/approvalKeepWaiting",
          "agent/steer",
          "agent/unsteer",
          "agent/backgroundShells",
          "agent/configure",
          "agent/query",
        ].includes(request.method);
      const admission: WorkbenchAdmission = local
        ? { type: "dispatch", id: request.id, generation }
        : await nativeAdmission(request);
      current();
      if (admission.type === "reply") {
        if (admission.error) throw new WorkerCommandError(admission.error);
        return admission.result ?? null;
      }
      const frame = {
        jsonrpc: "2.0",
        id: admission.id,
        method: request.method,
        params: request.params,
      };
      const normalized = prepareAgentRunMetadata(
        JSON.stringify(frame),
        { origin: "renderer", producer: "agent:msg" },
        rendererRunFactReader(admission.facts ?? {}),
      );
      current();
      if (!active || generation !== admission.generation || !core.canSend())
        throw new Error("Worker generation changed");
      const outcome = await core.request(request.method, JSON.parse(normalized.outLine).params, {
        id: admission.id,
        timeoutMs:
          request.method === "agent/run" ||
          (request.method === "agent/forkSession" && request.params.mode === "summary")
            ? 0
            : 30_000,
        failFast: true,
        settleOnExit: true,
        consume: true,
        meta: { origin: "renderer", producer: "agent:msg" },
      });
      await observers.output?.drain();
      const error =
        outcome.status === "error"
          ? outcome.error
          : outcome.status === "result"
            ? undefined
            : { code: -32002, message: "Worker request ended: " + outcome.status };
      const response = {
        jsonrpc: "2.0",
        id: admission.id,
        ...(error ? { error } : { result: outcome.status === "result" ? outcome.result : null }),
      };
      if (!local) post({ type: "renderer-settled", line: JSON.stringify(response) });
      current();
      if (error)
        throw new WorkerCommandError({
          code: error.code ?? -32603,
          message: error.message ?? "Worker request failed",
          ...("data" in error ? { data: error.data } : {}),
        });
      return outcome.status === "result" ? (outcome.result ?? null) : null;
    },
    pauseOutput: (paused: boolean) => core.pauseOutput(paused),
    publish(frames: OutputPublication[]) {
      const observed = frames.filter(({ envelope }) => {
        if (allDeltas || deltaSessions.has(envelope.sessionId)) return true;
        const type = (envelope.event as { type?: string } | null)?.type;
        return type !== "text_delta" && type !== "thinking_delta" && type !== "tool_use_args_delta";
      });
      if (observed.length) post({ type: "frames", frames: observed });
    },
  };
}

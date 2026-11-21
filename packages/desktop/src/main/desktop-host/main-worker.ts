import { AsyncLocalStorage } from "node:async_hooks";
import type {
  WorkerBridgeCoreOptions,
  WorkerFrameMeta,
  WorkerRequestOptions,
  WorkerRpcOutcome,
} from "@cjhyy/code-shell-server/worker";
import type {
  DesktopWorkerDriver,
  WorkerCommand,
  WorkerNotice,
  WorkerPort,
} from "./worker-wire.js";

interface WorkerInstance {
  generation: number;
}

/** Main's native adapters issue replies only to the worker which requested
 * them, even when a permission dialog outlives a worker or Host restart. */
export class DesktopHostWorkerClient implements DesktopWorkerDriver {
  private port?: WorkerPort;
  private generation = 0;
  private active?: WorkerInstance;
  private nextCall = 0;
  private readonly handling = new AsyncLocalStorage<WorkerInstance>();
  private readonly lines = new Set<(line: string) => void>();
  private readonly calls = new Map<number, (outcome: WorkerRpcOutcome) => void>();

  constructor(readonly options: WorkerBridgeCoreOptions) {}
  bind(port: WorkerPort): void {
    this.disconnect();
    this.port = port;
    port.on("message", ({ data, ports }) => {
      for (const foreign of ports) foreign.close();
      if (this.port !== port || ports.length || !data || typeof data !== "object") return;
      this.receive(data as WorkerNotice);
    });
    port.on("close", () => {
      if (this.port === port) this.disconnect();
    });
    port.start();
  }

  disconnect(): void {
    const previous = this.port;
    this.port = undefined;
    previous?.close();
    for (const settle of this.calls.values()) settle({ status: "workerExit" });
    this.calls.clear();
    if (!this.active) return;
    this.active = undefined;
    this.options.onExit?.({ code: null, signal: null, clean: false, gaveUp: false });
  }

  private post(message: WorkerCommand): boolean {
    if (!this.port) return false;
    const handling = this.handling.getStore();
    if (handling && handling !== this.active) return false;
    try {
      this.port.postMessage(message);
      return true;
    } catch {
      this.disconnect();
      return false;
    }
  }

  private receive(message: WorkerNotice): void {
    if (message.type === "result") {
      const finish = this.calls.get(message.call);
      this.calls.delete(message.call);
      finish?.(message.outcome);
      return;
    }
    const active = this.active;
    if (!active || message.generation !== active.generation) return;
    switch (message.type) {
      case "started":
        this.options.onWorkerStarted?.({ generation: active.generation, pid: message.pid });
        break;
      case "spawn-failed":
        this.active = undefined;
        if (message.message) this.options.onSpawnError?.(new Error(message.message));
        else this.options.onSpawnFailed?.();
        break;
      case "exit":
        this.active = undefined;
        this.options.onExit?.(message.info);
        break;
      case "stderr":
        this.options.onStderr?.(message.text);
        break;
      case "line":
        this.handling.run(active, () => {
          for (const listener of this.lines) {
            try {
              listener(message.line);
            } catch (error) {
              this.options.log?.("line_listener.threw", { error: String(error) });
            }
          }
        });
        break;
    }
  }

  ensureWorker(requestedCwd?: string): void {
    if (this.active || !this.port || this.handling.getStore()) return;
    const cwd = requestedCwd ?? this.options.fallbackCwd?.() ?? process.cwd();
    const generation = this.generation + 1;
    const env = this.options.buildEnv?.() ?? process.env;
    this.active = { generation };
    if (this.post({ type: "start", generation, cwd, env })) this.generation = generation;
  }

  workerGeneration(): number {
    return this.generation;
  }
  hasChild(): boolean {
    return !!this.active;
  }
  canSend(): boolean {
    const handling = this.handling.getStore();
    return !!this.active && (!handling || handling === this.active);
  }
  hasLiveWorker(): boolean {
    return !!this.active;
  }

  subscribeLines(listener: (line: string) => void): () => void {
    this.lines.add(listener);
    return () => {
      this.lines.delete(listener);
    };
  }
  sendLine(line: string): boolean {
    return !!this.active && this.post({ type: "write", generation: this.active.generation, line });
  }

  injectWorkerMessage(line: string, meta: WorkerFrameMeta): void {
    const prepared = this.options.prepareInbound?.(line, meta);
    this.sendLine(prepared?.line ?? line);
  }

  async request(
    method: string,
    params: unknown,
    options: WorkerRequestOptions,
  ): Promise<WorkerRpcOutcome> {
    if (
      options.waitForRunCompletion &&
      (method !== "agent/run" || !options.failFast || !options.settleOnExit)
    )
      return {
        status: "sendFailed",
        error: new Error("Completion tracking requires agent/run, failFast and settleOnExit"),
      };
    try {
      const raw = JSON.stringify({ jsonrpc: "2.0", id: options.id, method, params });
      const prepared = this.options.prepareInbound?.(raw, options.meta);
      const frame = prepared ? JSON.parse(prepared.line) : { method, params };
      if (options.ensureWorker) this.ensureWorker(options.ensureWorkerCwd);
      if (!this.port || (this.handling.getStore() && !this.canSend()))
        return { status: "sendFailed" };
      const call = ++this.nextCall;
      return new Promise((resolve) => {
        this.calls.set(call, resolve);
        if (
          !this.post({
            type: "request",
            generation: this.generation,
            call,
            method: frame.method,
            params: frame.params,
            options,
          })
        ) {
          this.calls.delete(call);
          resolve({ status: "sendFailed" });
        }
      });
    } catch (error) {
      const reason = error as { code?: number; message?: string };
      if (typeof reason?.code === "number")
        return { status: "error", error: { code: reason.code, message: reason.message } };
      return { status: "sendFailed", error };
    }
  }
  kill(): void {
    if (this.active) this.post({ type: "stop", generation: this.active.generation });
  }
}

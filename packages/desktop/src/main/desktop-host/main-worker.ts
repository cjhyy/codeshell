import type { IpcMainEvent } from "electron";
import type { DesktopHostIdentity } from "../../shared/desktop-host-protocol.js";
import type { WorkbenchIngressAdapter } from "./ingress-wire.js";
import type { Snapshot } from "../SessionSnapshotStore.js";
import type { OutputMutation, OutputPublication } from "./stored-output.js";
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
  private boundOnce = false;
  private readonly startupWaiters = new Set<() => void>();
  private generation = 0;
  private active?: WorkerInstance;
  private nextCall = 0;
  private readonly outputCalls = new Map<
    number,
    { resolve(value?: Snapshot): void; reject(error: Error): void }
  >();
  private readonly outputListeners = new Set<(frame: OutputPublication) => void>();
  private deltaInterest: { all: boolean; sessions: string[] } = { all: false, sessions: [] };
  private readonly handling = new AsyncLocalStorage<WorkerInstance>();
  private readonly lines = new Set<(line: string) => void>();
  private readonly calls = new Map<number, (outcome: WorkerRpcOutcome) => void>();

  private ingress?: WorkbenchIngressAdapter;
  setIngress(adapter: WorkbenchIngressAdapter): void {
    this.ingress = adapter;
  }
  constructor(
    readonly options: WorkerBridgeCoreOptions,
    private readonly assertWorkbench?: (identity: DesktopHostIdentity) => void,
    private readonly legacy?: (event: IpcMainEvent, line: string) => boolean,
  ) {}
  legacyWorkbench(event: IpcMainEvent, line: string): boolean {
    return this.legacy?.(event, line) ?? false;
  }

  async waitForFirstBinding(): Promise<void> {
    if (this.port) return;
    if (this.boundOnce || this.startupWaiters.size >= 128)
      throw new Error("Desktop Host is unavailable");
    const gate = Promise.withResolvers<void>();
    this.startupWaiters.add(gate.resolve);
    const timer = setTimeout(
      () => gate.reject(new Error("Desktop Host startup timed out")),
      15_000,
    ).unref();
    try {
      await gate.promise;
    } finally {
      clearTimeout(timer);
      this.startupWaiters.delete(gate.resolve);
    }
    if (!this.port) throw new Error("Desktop Host is unavailable");
  }

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
    this.boundOnce = true;
    for (const ready of this.startupWaiters) ready();
    if (this.deltaInterest.all || this.deltaInterest.sessions.length)
      this.post({ type: "delta-interest", ...this.deltaInterest });
  }

  disconnect(): void {
    const previous = this.port;
    this.port = undefined;
    previous?.close();
    for (const settle of this.calls.values()) settle({ status: "workerExit" });
    this.calls.clear();
    for (const call of this.outputCalls.values())
      call.reject(new Error("Desktop Host is unavailable"));
    this.outputCalls.clear();
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
    if (message.type === "renderer-settled") {
      void this.ingress
        ?.settled(message.line)
        .catch((error) =>
          this.options.log?.("renderer.settlement_failed", { error: String(error) }),
        );
      return;
    }
    if (message.type === "renderer-prepare") {
      const port = this.port;
      const assertCurrent = () => {
        if (!this.assertWorkbench || !port || this.port !== port)
          throw new Error("Workbench document was revoked");
        this.assertWorkbench(message.request.identity);
      };
      const fail = (error: unknown) => {
        if (port && port === this.port)
          this.post({
            type: "renderer-admitted",
            call: message.call,
            admission: {
              type: "reply",
              error: {
                code: -32003,
                message: error instanceof Error ? error.message : "Request unavailable",
              },
            },
          });
      };
      void Promise.resolve()
        .then(() => {
          assertCurrent();
          if (!this.ingress) throw new Error("Agent admission is unavailable");
          return this.ingress.prepare(message.request, assertCurrent);
        })
        .then((admission) => {
          assertCurrent();
          const reply = () => {
            try {
              assertCurrent();
              if (admission.type === "dispatch" && this.active?.generation !== admission.generation)
                throw new Error("Worker generation changed");
              return this.post({ type: "renderer-admitted", call: message.call, admission });
            } catch (error) {
              fail(error);
              return false;
            }
          };
          if (admission.type === "dispatch" && this.options.dispatchInput) {
            const line = JSON.stringify({
              jsonrpc: "2.0",
              id: admission.id,
              method: message.request.method,
              params: message.request.params,
            });
            if (!this.options.dispatchInput(admission.generation, line, reply))
              fail(new Error("Worker input unavailable"));
          } else reply();
        })
        .catch(fail);
      return;
    }
    if (message.type === "frames") {
      for (const frame of message.frames)
        for (const listener of this.outputListeners) {
          try {
            listener(frame);
          } catch (error) {
            this.options.log?.("output_listener.threw", { error: String(error) });
          }
        }
      return;
    }
    if (message.type === "output-result") {
      const pending = this.outputCalls.get(message.call);
      this.outputCalls.delete(message.call);
      if (message.error) pending?.reject(new Error(message.error));
      else pending?.resolve(message.snapshot);
      return;
    }
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

  setDeltaInterest(all: boolean, sessions: string[]): void {
    this.deltaInterest = { all, sessions };
    this.post({ type: "delta-interest", all, sessions });
  }

  get hostedOutput() {
    return this;
  }
  captureGeneration(): () => boolean {
    const port = this.port;
    return () => !!port && port === this.port;
  }
  onOutput(listener: (frame: OutputPublication) => void): () => void {
    this.outputListeners.add(listener);
    return () => {
      this.outputListeners.delete(listener);
    };
  }
  private outputCall(
    command: Extract<WorkerCommand, { type: "output" | "snapshot" }>,
  ): Promise<Snapshot | undefined> {
    return new Promise((resolve, reject) => {
      this.outputCalls.set(command.call, { resolve, reject });
      if (!this.post(command)) {
        this.outputCalls.delete(command.call);
        reject(new Error("Desktop Host is unavailable"));
      }
    });
  }
  async readSnapshot(sessionId: string, sinceSeq = 0): Promise<Snapshot> {
    const snapshot = await this.outputCall({
      type: "snapshot",
      sessionId,
      sinceSeq,
      call: ++this.nextCall,
    });
    if (!snapshot) throw new Error("Desktop Host returned no output snapshot");
    return snapshot;
  }
  async mutateOutput(command: OutputMutation): Promise<void> {
    await this.outputCall({ type: "output", command, call: ++this.nextCall });
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

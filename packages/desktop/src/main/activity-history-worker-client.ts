import { Worker } from "node:worker_threads";
import type { UsageQuery, UsageSummary } from "@cjhyy/code-shell-core";
import type { createTraceHistoryService } from "./trace-history-service.js";

type TraceHistory = ReturnType<typeof createTraceHistoryService>;
export interface ActivityHistoryWorkerOptions {
  sessionsDir: string;
}
export interface ActivityHistoryWorkerRequest {
  id: number;
  method: keyof TraceHistory | "usage" | "flush";
  input?: unknown;
}
export interface ActivityHistoryWorkerReply {
  id: number;
  value?: unknown;
  error?: string;
}
type HistoryWorker = Pick<Worker, "on" | "postMessage" | "ref" | "unref" | "terminate">;

/** Disk history scans and capture-policy maintenance never run on Electron Main. */
export class ActivityHistoryWorker {
  private worker?: HistoryWorker;
  private nextId = 0;
  private failure?: Error;
  private closing?: Promise<void>;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(
    private readonly options: ActivityHistoryWorkerOptions,
    private readonly createWorker: (options: ActivityHistoryWorkerOptions) => HistoryWorker = (
      options,
    ) =>
      new Worker(
        new URL(
          import.meta.url.endsWith(".ts")
            ? "./activity-history-worker.ts"
            : "./activity-history-worker.mjs",
          import.meta.url,
        ),
        { workerData: options },
      ),
  ) {}

  usage(query?: UsageQuery): Promise<UsageSummary> {
    return this.request("usage", query);
  }
  list(query?: unknown): Promise<ReturnType<TraceHistory["list"]>> {
    return this.request("list", query);
  }
  sessions(query?: unknown): Promise<ReturnType<TraceHistory["sessions"]>> {
    return this.request("sessions", query);
  }
  get(id: unknown): Promise<ReturnType<TraceHistory["get"]>> {
    return this.request("get", id);
  }
  getConfig(): Promise<ReturnType<TraceHistory["getConfig"]>> {
    return this.request("getConfig");
  }
  setConfig(patch: unknown): Promise<ReturnType<TraceHistory["setConfig"]>> {
    return this.request("setConfig", patch);
  }

  /** Drain accepted requests and retention work before terminating; refuse new intake. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const drained = this.worker || this.failure ? this.request("flush") : Promise.resolve();
    this.closing = drained
      .then(() => undefined)
      .finally(async () => {
        const worker = this.worker;
        this.worker = undefined;
        if (worker) await worker.terminate();
      });
    return this.closing;
  }

  private request<T>(method: ActivityHistoryWorkerRequest["method"], input?: unknown): Promise<T> {
    if (this.closing) return Promise.reject(new Error("activity history is closed"));
    if (this.failure) return Promise.reject(this.failure);
    // A stalled reader must not retain an unbounded number of renderer requests.
    if (method !== "flush" && this.pending.size >= 64)
      return Promise.reject(new Error("Too many pending history requests"));
    return new Promise<T>((resolve, reject) => {
      try {
        const worker = this.getWorker();
        const id = ++this.nextId;
        this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
        worker.ref();
        worker.postMessage({ id, method, input } satisfies ActivityHistoryWorkerRequest);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        reject(this.failure!);
      }
    });
  }

  private getWorker(): HistoryWorker {
    if (this.worker) return this.worker;
    const worker = this.createWorker(this.options);
    this.worker = worker;
    worker.on("message", (reply: ActivityHistoryWorkerReply) => {
      const request = this.pending.get(reply.id);
      if (!request) return;
      this.pending.delete(reply.id);
      if (reply.error !== undefined) request.reject(new Error(reply.error));
      else request.resolve(reply.value);
      if (!this.pending.size) worker.unref();
    });
    worker.on("error", (error: Error) => this.fail(error));
    worker.on("exit", (code: number) => {
      if (this.worker === worker) this.fail(new Error(`activity history worker exited (${code})`));
    });
    worker.unref();
    return worker;
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const request of this.pending.values()) request.reject(this.failure);
    this.pending.clear();
    this.worker?.unref();
  }
}

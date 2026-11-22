import type { MimiReplyOperations } from "../shared/mimi-gateway-turn.js";
import type { ProfileWorkerReads } from "../shared/profile-library.js";
import type { AgentDefinitionReads } from "../shared/agent-definitions.js";
type WorkerViews = ActivityReads & ProfileWorkerReads & AgentDefinitionReads;
import type {
  petSegmentTranscript,
  SegmentClosureInput,
} from "./pet/pet-segment-closure-service.js";
import type { ShellBusinessOperations } from "../shared/shell-business-contracts.js";
import type { CcRoomReads, CliList, CliHistory } from "../shared/cc-room-reads.js";
import type { ActivityReads } from "../shared/activity-history-contracts.js";
import { Worker } from "node:worker_threads";
import type { UsageQuery, UsageSummary } from "@cjhyy/code-shell-core";
import type { createTraceHistoryService } from "./trace-history-service.js";

type TraceHistory = ReturnType<typeof createTraceHistoryService>;
export interface ActivityHistoryWorkerOptions {
  sessionsDir: string;
  roomsDir?: string;
  petDir?: string;
}
export interface ActivityHistoryWorkerRequest {
  id: number;
  method:
    | keyof TraceHistory
    | keyof import("../shared/room-history.js").RoomHistoryOperations
    | "externalSessions"
    | "externalHistory"
    | keyof MimiReplyOperations
    | "mimiSummaryInput"
    | "mimiSegmentWindow"
    | "mimiSegmentMessages"
    | "mimiExternalActivity"
    | "flush"
    | keyof WorkerViews
    | "files/turnHistory"
    | "activity/setTitle";
  permit?: Int32Array;
  input?: unknown;
}
export interface ActivityHistoryWorkerReply {
  id: number;
  value?: unknown;
  error?: string;
}
type HistoryWorker = Pick<Worker, "on" | "postMessage" | "ref" | "unref" | "terminate">;

/** The production worker thread (also used by tests that must reap it on failure). */
export function createActivityHistoryWorker(options: ActivityHistoryWorkerOptions): Worker {
  return new Worker(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./activity-history-worker.ts"
        : "./activity-history-worker.mjs",
      import.meta.url,
    ),
    { workerData: options },
  );
}

/** Disk history scans and capture-policy maintenance never run on Electron Main. */
export class ActivityHistoryWorker {
  private worker?: HistoryWorker;
  // Do not send work until the thread has finished loading its handlers. A fast
  // quit can then cancel dashboard reads that have provably never executed.
  private startupQueue?: ActivityHistoryWorkerRequest[] = [];
  private nextId = 0;
  private failure?: Error;
  private closing?: Promise<void>;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(
    private readonly options: ActivityHistoryWorkerOptions,
    private readonly createWorker: (
      options: ActivityHistoryWorkerOptions,
    ) => HistoryWorker = createActivityHistoryWorker,
  ) {}

  onExternalActivityChanged?: () => void;
  mimiReply<K extends keyof MimiReplyOperations>(
    method: K,
    input: MimiReplyOperations[K]["input"],
    permit?: Int32Array,
  ): Promise<MimiReplyOperations[K]["result"]> {
    return this.request(method, input, permit);
  }
  mimiSummaryInput(sessionId: string): Promise<string | null> {
    return this.request("mimiSummaryInput", sessionId);
  }
  mimiSegmentWindow(input: {
    petSessionId: string;
    input: SegmentClosureInput;
  }): ReturnType<ReturnType<typeof petSegmentTranscript>["prepare"]> {
    return this.request("mimiSegmentWindow", input);
  }
  mimiSegmentMessages(input: {
    petSessionId: string;
    range: { start: number; end: number };
  }): ReturnType<ReturnType<typeof petSegmentTranscript>["read"]> {
    return this.request("mimiSegmentMessages", input);
  }
  mimiExternalActivity(input: {
    projectCwds?: string[];
  }): Promise<import("./pet/pet-state-aggregator.js").DesktopPetSession[]> {
    return this.request("mimiExternalActivity", input);
  }

  roomHistory<K extends keyof import("../shared/room-history.js").RoomHistoryOperations>(
    method: K,
    input: ShellBusinessOperations[K]["input"],
  ): Promise<ShellBusinessOperations[K]["result"]> {
    return this.request(method, input);
  }

  externalSessions(input: CliList): Promise<CcRoomReads["ccRoom/sessions"]["result"]> {
    return this.request("externalSessions", input);
  }
  externalHistory(input: CliHistory): Promise<CcRoomReads["ccRoom/history"]["result"]> {
    return this.request("externalHistory", input);
  }
  usage(query?: UsageQuery): Promise<UsageSummary> {
    return this.view("activity/usage", { query });
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
  setConfig(patch: unknown, permit?: Int32Array): Promise<ReturnType<TraceHistory["setConfig"]>> {
    return this.request("setConfig", patch, permit);
  }

  view<K extends keyof WorkerViews>(
    method: K,
    input: WorkerViews[K]["params"],
  ): Promise<WorkerViews[K]["result"]> {
    return this.request(method, input);
  }
  turnHistory(input: ShellBusinessOperations["files/turnHistory"]["input"], permit: Int32Array):
    Promise<ShellBusinessOperations["files/turnHistory"]["result"]> {
    return this.request("files/turnHistory", input, permit);
  }
  setTitle(input: { id: string; title: string }, permit: Int32Array): Promise<void> {
    return this.request("activity/setTitle", input, permit);
  }
  /** Flush writes and possible trace maintenance before terminating a running worker. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const unstartedReads = this.startupQueue?.every(({ method }) =>
      method === "mimiExternalActivity" || method === "activity/runs" || method === "profiles/list",
    );
    if (unstartedReads) {
      this.startupQueue = undefined;
      this.rejectPending(new Error("activity history is closed"));
    }
    let drained = Promise.resolve();
    if (this.failure) drained = Promise.reject(this.failure);
    else if (this.worker && !unstartedReads) drained = this.request<void>("flush");
    this.closing = drained
      .then(() => undefined)
      .finally(async () => {
        const worker = this.worker;
        this.worker = undefined;
        if (worker) await worker.terminate();
      });
    return this.closing;
  }

  private request<T>(
    method: ActivityHistoryWorkerRequest["method"],
    input?: unknown,
    permit?: Int32Array,
  ): Promise<T> {
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
        const request = { id, method, input, ...(permit && { permit }) };
        if (this.startupQueue) this.startupQueue.push(structuredClone(request));
        else worker.postMessage(request);
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
    worker.on(
      "message",
      (reply: ActivityHistoryWorkerReply | { type: "ready" | "mimi-external-changed" }) => {
        if ("type" in reply) {
          if (reply.type === "ready") {
            const queued = this.startupQueue;
            this.startupQueue = undefined;
            try {
              for (const request of queued ?? []) worker.postMessage(request);
            } catch (error) {
              this.fail(error instanceof Error ? error : new Error(String(error)));
            }
          } else if (!this.closing) this.onExternalActivityChanged?.();
          return;
        }
        const request = this.pending.get(reply.id);
        if (!request) return;
        this.pending.delete(reply.id);
        if (reply.error !== undefined) request.reject(new Error(reply.error));
        else request.resolve(reply.value);
        if (!this.pending.size) worker.unref();
      },
    );
    worker.on("error", (error: Error) => this.fail(error));
    worker.on("exit", (code: number) => {
      if (this.worker === worker) this.fail(new Error(`activity history worker exited (${code})`));
    });
    worker.unref();
    return worker;
  }

  private fail(error: Error): void {
    if (!this.failure) {
      this.failure = error;
      if (!this.closing) this.onExternalActivityChanged?.();
    }
    this.startupQueue = undefined;
    this.rejectPending(this.failure);
    this.worker?.unref();
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

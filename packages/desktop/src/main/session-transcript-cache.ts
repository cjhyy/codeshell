import { Worker } from "node:worker_threads";
import type {
  SessionTranscriptCacheKey,
  SessionTranscriptCacheRead,
} from "../shared/session-catalog.js";
import type { SessionTranscriptCacheOptions } from "./session-transcript-cache-store.js";
export type { SessionTranscriptCacheOptions } from "./session-transcript-cache-store.js";

export interface TranscriptCacheWorkerRequest {
  id: number;
  method: "write" | "read" | "delete" | "flush";
  input?: SessionTranscriptCacheKey & { value?: string; legacy?: boolean; maxBytes?: number };
}
export interface TranscriptCacheWorkerReply {
  id: number;
  value?: SessionTranscriptCacheRead;
  error?: string;
}

type CacheWorker = Pick<Worker, "on" | "postMessage" | "ref" | "unref" | "terminate">;

/** Keep full-file JSON parsing, merging, locks and durable writes off Main.
 * One worker preserves FIFO ordering; the store retains cross-process locks. */
export class SessionTranscriptCache {
  private worker?: CacheWorker;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: SessionTranscriptCacheRead | undefined) => void;
      reject: (error: Error) => void;
    }
  >();
  private failure?: Error;
  private closing?: Promise<void>;

  constructor(
    private readonly options: SessionTranscriptCacheOptions = {},
    private readonly createWorker: (options: SessionTranscriptCacheOptions) => CacheWorker = (
      options,
    ) =>
      new Worker(
        new URL(
          import.meta.url.endsWith(".ts")
            ? "./session-transcript-cache-worker.ts"
            : "./session-transcript-cache-worker.mjs",
          import.meta.url,
        ),
        { workerData: options },
      ),
  ) {}

  write(input: SessionTranscriptCacheKey & { value: string; legacy?: boolean }): Promise<void> {
    return this.request("write", input).then(() => undefined);
  }
  read(
    input: SessionTranscriptCacheKey & { maxBytes?: number },
  ): Promise<SessionTranscriptCacheRead> {
    return this.request("read", input) as Promise<SessionTranscriptCacheRead>;
  }
  delete(input: SessionTranscriptCacheKey): Promise<void> {
    return this.request("delete", input).then(() => undefined);
  }
  flush(): Promise<void> {
    if (this.closing) return this.closing;
    if (!this.worker && !this.failure) return Promise.resolve();
    return this.request("flush").then(() => undefined);
  }

  /** Refuse new work, drain every accepted operation, then terminate the thread. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const drained = this.flush();
    this.closing = drained.finally(async () => {
      const worker = this.worker;
      this.worker = undefined;
      if (worker) await worker.terminate();
    });
    return this.closing;
  }

  private request(
    method: TranscriptCacheWorkerRequest["method"],
    input?: TranscriptCacheWorkerRequest["input"],
  ): Promise<SessionTranscriptCacheRead | undefined> {
    if (this.closing) return Promise.reject(new Error("transcript cache is closed"));
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      try {
        const worker = this.getWorker();
        const id = ++this.nextId;
        this.pending.set(id, { resolve, reject });
        worker.ref();
        worker.postMessage({ id, method, input } satisfies TranscriptCacheWorkerRequest);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        reject(this.failure!);
      }
    });
  }

  private getWorker(): CacheWorker {
    if (this.worker) return this.worker;
    const worker = this.createWorker(this.options);
    this.worker = worker;
    worker.on("message", (reply: TranscriptCacheWorkerReply) => {
      const request = this.pending.get(reply.id);
      if (!request) return;
      this.pending.delete(reply.id);
      if (reply.error !== undefined) request.reject(new Error(reply.error));
      else request.resolve(reply.value);
      // Idle caches must not hold test processes or a completed app shutdown open.
      if (!this.pending.size) worker.unref();
    });
    worker.on("error", (error: Error) => this.fail(error));
    worker.on("exit", (code: number) => {
      if (this.worker === worker) this.fail(new Error(`transcript cache worker exited (${code})`));
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

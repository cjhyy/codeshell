import { Worker } from "node:worker_threads";
import type { RelatedSessionDiscoveryOptions } from "./related-session-discovery.js";
import type { DiscoveredSession, DiscoverOptions } from "./session-discovery.js";

export interface ClaudeSessionList {
  sessions: DiscoveredSession[];
  total: number;
}

type HistoryWorker = Pick<Worker, "once" | "terminate" | "unref">;

/** Local lifecycle seam: production uses one shared queue and native workers. */
export function createClaudeSessionLister({
  createWorker = (workerData: unknown): HistoryWorker => {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    return new Worker(new URL(`./claude-session-list-worker.${extension}`, import.meta.url), {
      workerData,
    });
  },
  timeoutMs = 120_000,
}: {
  createWorker?: (workerData: unknown) => HistoryWorker;
  timeoutMs?: number;
} = {}) {
  let pending = 0;
  let queue: Promise<void> = Promise.resolve();
  let blockedWorker: HistoryWorker | undefined;
  const blockedError = () => new Error("Claude history worker is still shutting down");

  function runDiscovery(workerData: unknown): Promise<ClaudeSessionList> {
    return new Promise((resolve, reject) => {
      const worker = createWorker(workerData);
      let settled = false;
      let exited = false;
      const timer = setTimeout(
        () => finish(new Error("Claude history discovery timed out")),
        timeoutMs,
      );
      const release = () => {
        if (blockedWorker === worker) blockedWorker = undefined;
      };
      const finish = (error?: Error, value?: ClaudeSessionList) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          // Native synchronous I/O can delay terminate() indefinitely. Surface
          // the deadline now, and refuse more workers until this one is gone.
          if (!exited) blockedWorker = worker;
          reject(error);
        }
        let termination: Promise<number>;
        try {
          termination = worker.terminate();
        } catch (terminationError) {
          termination = Promise.reject(terminationError);
        }
        // Node's terminate() re-refs the worker, so unref must happen afterwards.
        if (error) worker.unref();
        void termination.then(
          () => {
            release();
            if (!error) resolve(value!);
          },
          (terminationError) => {
            if (!exited) blockedWorker = worker;
            worker.unref();
            if (!error) reject(terminationError);
          },
        );
      };
      worker.once("message", (reply) =>
        reply.ok ? finish(undefined, reply.value) : finish(new Error(reply.error)),
      );
      worker.once("error", (error) => finish(error));
      worker.once("exit", (code) => {
        exited = true;
        release();
        if (!settled) finish(new Error(`Claude history worker exited before replying (${code})`));
      });
    });
  }

  return function listRelatedClaudeSessions(
    cwd: string,
    opts: DiscoverOptions = {},
    discovery: RelatedSessionDiscoveryOptions = {},
    all = false,
  ): Promise<ClaudeSessionList> {
    if (blockedWorker) return Promise.reject(blockedError());
    if (pending >= 32) return Promise.reject(new Error("Claude history discovery is busy"));
    const request = structuredClone({ cwd, opts, discovery, all });
    pending++;
    const result = queue.then(() => {
      if (blockedWorker) throw blockedError();
      return runDiscovery(request);
    });
    queue = result.then(
      () => {
        pending--;
      },
      () => {
        pending--;
      },
    );
    return result;
  };
}

/**
 * Keep full transcript JSON parsing off the UI host. One worker at a time
 * bounds disk pressure and memory even when several windows list history.
 * The established scanner retains exact title/count/collision semantics.
 */
export const listRelatedClaudeSessions = createClaudeSessionLister();

import { Worker } from "node:worker_threads";
import type { RelatedSessionDiscoveryOptions } from "./related-session-discovery.js";
import type { DiscoveredSession, DiscoverOptions } from "./session-discovery.js";

export interface ClaudeSessionList {
  sessions: DiscoveredSession[];
  total: number;
}

let pending = 0;
let queue: Promise<void> = Promise.resolve();

/**
 * Keep full transcript JSON parsing off the UI host. One worker at a time
 * bounds disk pressure and memory even when several windows list history.
 * The established scanner retains exact title/count/collision semantics.
 */
export function listRelatedClaudeSessions(
  cwd: string,
  opts: DiscoverOptions = {},
  discovery: RelatedSessionDiscoveryOptions = {},
  all = false,
): Promise<ClaudeSessionList> {
  if (pending >= 32) return Promise.reject(new Error("Claude history discovery is busy"));
  const request = structuredClone({ cwd, opts, discovery, all });
  pending++;
  const result = queue.then(() => runDiscovery(request));
  queue = result.then(
    () => {
      pending--;
    },
    () => {
      pending--;
    },
  );
  return result;
}

function runDiscovery(workerData: unknown): Promise<ClaudeSessionList> {
  return new Promise((resolve, reject) => {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const worker = new Worker(
      new URL(`./claude-session-list-worker.${extension}`, import.meta.url),
      {
        workerData,
      },
    );
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error("Claude history discovery timed out")),
      120_000,
    );
    const finish = (error?: Error, value?: ClaudeSessionList) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const settle = () => {
        if (error) reject(error);
        else resolve(value!);
      };
      void worker.terminate().then(settle, settle);
    };
    worker.once("message", (reply) =>
      reply.ok ? finish(undefined, reply.value) : finish(new Error(reply.error)),
    );
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => {
      if (!settled) finish(new Error(`Claude history worker exited before replying (${code})`));
    });
  });
}

import { claimBusinessCommit } from "../host/composition/business-calls.js";
import { parentPort, workerData } from "node:worker_threads";
import { SessionTranscriptCacheStore } from "./session-transcript-cache-store.js";
import type {
  TranscriptCacheWorkerRequest,
  TranscriptCacheWorkerReply,
} from "./session-transcript-cache.js";

const port = parentPort;
if (!port) throw new Error("transcript cache requires a worker thread");
const store = new SessionTranscriptCacheStore(workerData);
port.on("message", async ({ id, method, input, permit }: TranscriptCacheWorkerRequest) => {
  try {
    let value: TranscriptCacheWorkerReply["value"];
    const commit = permit ? () => claimBusinessCommit(permit) : undefined;
    if (method === "write") await store.write(input as Parameters<typeof store.write>[0], commit);
    else if (method === "read") value = await store.read(input!);
    else if (method === "delete") await store.delete(input!, commit);
    else if (method === "flush") await store.flush();
    else throw new Error("unknown transcript cache operation");
    port.postMessage({ id, value } satisfies TranscriptCacheWorkerReply);
  } catch (error) {
    port.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies TranscriptCacheWorkerReply);
  }
});

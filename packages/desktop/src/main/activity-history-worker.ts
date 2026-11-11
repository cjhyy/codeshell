import { parentPort, workerData } from "node:worker_threads";
import { join } from "node:path";
import { ModelTraceStore } from "@cjhyy/code-shell-core/internal";
import { createTraceHistoryService } from "./trace-history-service.js";
import { readUsageHistory } from "./usage-history-service.js";
import type {
  ActivityHistoryWorkerOptions,
  ActivityHistoryWorkerReply,
  ActivityHistoryWorkerRequest,
} from "./activity-history-worker-client.js";

const port = parentPort;
if (!port) throw new Error("activity history requires a worker thread");
const options = workerData as ActivityHistoryWorkerOptions;
const store = new ModelTraceStore({ storageDir: join(options.sessionsDir, ".model-traces") });
const history = createTraceHistoryService({ storageDir: store.storageDir, store });
let tail = Promise.resolve();
port.on("message", ({ id, method, input }: ActivityHistoryWorkerRequest) => {
  // FIFO includes configuration writes and the shutdown maintenance barrier.
  tail = tail.then(async () => {
    try {
      let value: unknown;
      if (method === "usage")
        value = readUsageHistory(
          input as Parameters<typeof readUsageHistory>[0],
          options.sessionsDir,
        );
      else if (method === "list") value = history.list(input);
      else if (method === "sessions") value = history.sessions(input);
      else if (method === "get") value = history.get(input);
      else if (method === "getConfig") value = history.getConfig();
      else if (method === "setConfig") value = history.setConfig(input);
      else if (method === "flush") await store.flushMaintenance();
      else throw new Error("Unknown activity history operation");
      port.postMessage({ id, value } satisfies ActivityHistoryWorkerReply);
    } catch (error) {
      port.postMessage({
        id,
        error: error instanceof Error ? error.message : String(error),
      } satisfies ActivityHistoryWorkerReply);
    }
  });
});

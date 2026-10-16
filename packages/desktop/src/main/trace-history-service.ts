import { join } from "node:path";
import { sessionsRoot } from "@cjhyy/code-shell-core";
import { createModelTraceHistory, type ModelTraceReader } from "@cjhyy/code-shell-server/storage";

/** The native application can inspect its own complete Host model history. */
export function createTraceHistoryService(
  options: { storageDir?: string; store?: ModelTraceReader } = {},
) {
  return createModelTraceHistory({
    storageDir: options.storageDir ?? join(sessionsRoot(), ".model-traces"),
    store: options.store,
  });
}

import { listSessions } from "./sessions-service.js";
import { reconcileSessionHistory } from "./session-history-index.js";
import {
  serveStorageWorker,
  type StorageWorkerHandlers,
} from "@cjhyy/code-shell-core/internal/storage";
import { reconcileSessionIndex } from "./session-index-reconcile.js";

/** Single storage queue for this data root, shared by every registered domain. */
export function serveSessionIndexWorker(extra?: StorageWorkerHandlers): Promise<void> {
  return serveStorageWorker({
    ...extra,
    async initialize(ctx) {
      if (ctx.db) {
        reconcileSessionIndex(ctx.db, ctx.sessionsRoot);
        await reconcileSessionHistory(ctx.db, ctx.sessionsRoot);
      }
      await extra?.initialize?.(ctx);
    },
    async handle(ctx, command, payload) {
      if (command === "sessions/historyFallback") return listSessions(ctx.sessionsRoot);
      if (command === "sessions/reconcile") {
        if (!ctx.db) return false;
        if (
          payload !== undefined &&
          (!Array.isArray(payload) ||
            payload.length > 512 ||
            !payload.every((id) => typeof id === "string"))
        )
          throw new Error("Invalid dirty session list");
        reconcileSessionIndex(ctx.db, ctx.sessionsRoot, payload);
        await reconcileSessionHistory(ctx.db, ctx.sessionsRoot, payload);
        return true;
      }
      if (extra?.handle) return extra.handle(ctx, command, payload);
      throw new Error("Unknown storage command");
    },
  });
}

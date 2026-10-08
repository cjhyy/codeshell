/** Read-only local Host view over durable request receipts. */
import {
  UsageLedger,
  SessionManager,
  sessionsRoot,
  type UsageQuery,
  type UsageSummary,
} from "@cjhyy/code-shell-core";
import { join } from "node:path";
import { assertDesktopSessionId } from "./session-validation.js";

export function readUsageHistory(
  query: UsageQuery = {},
  sessionsDir = sessionsRoot(),
): UsageSummary {
  if (!query || typeof query !== "object" || Array.isArray(query))
    throw new Error("Invalid usage query");
  const scope = query.scope ?? (query.sessionId ? "session" : "store");
  if (scope !== "session" && scope !== "store") throw new Error("Invalid history scope");
  const ledger = new UsageLedger({ storageDir: join(sessionsDir, ".usage-ledger") });
  if (scope === "session") {
    assertDesktopSessionId(query.sessionId!);
    const state = new SessionManager(sessionsDir).readSessionState(query.sessionId!);
    if (!state) throw new Error("Session not found");
    if (
      !ledger.adoptSession(query.sessionId!, state.costState, sessionsDir) &&
      (state.costState != null || (state.tokenUsage?.totalTokens ?? 0) > 0)
    )
      ledger.noteHistoricalGap(query.sessionId!, sessionsDir);
  }
  return ledger.summary({ ...query, scope }, sessionsDir);
}

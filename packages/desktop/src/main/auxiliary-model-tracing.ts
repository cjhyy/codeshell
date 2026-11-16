import { isAbsolute, join } from "node:path";
import { lstatSync } from "node:fs";
import {
  SessionManager,
  UsageLedger,
  withUsageOwner,
  type SessionState,
} from "@cjhyy/code-shell-core";
import { withModelTraceContext } from "@cjhyy/code-shell-core/internal";

type UsageOwner = Parameters<typeof withUsageOwner>[0];

/** Ledger purposes; helper-specific trace purposes are accounted as auxiliary summaries. */
const LEDGER_PURPOSES = new Set<string>([
  "main",
  "aux_summary",
  "tool_summary",
  "goal_judge",
  "title",
  "context_package",
  "manual_compact",
  "subagent",
  "external",
]);

/**
 * Charge a helper call to the session it works for. The owner exists only
 * when that session already has a ledger reference; accounting never creates
 * one and never fails the helper.
 */
export function usageOwnerFor(
  sessionsRootDir: string,
  sessionId: string,
  state: SessionState | undefined,
  purpose: string,
): UsageOwner | undefined {
  if (!state?.costState) return undefined;
  try {
    const ledger = new UsageLedger({ storageDir: join(sessionsRootDir, ".usage-ledger") });
    if (!ledger.adoptSession(sessionId, state.costState, sessionsRootDir)) return undefined;
    return ledger.owner(
      sessionId,
      undefined,
      [],
      (LEDGER_PURPOSES.has(purpose) ? purpose : "aux_summary") as UsageOwner["purpose"],
      sessionsRootDir,
    );
  } catch {
    return undefined;
  }
}

/**
 * Trace a helper's model call and charge its usage to the source session.
 * A helper's settings cwd is not necessarily the workspace of its source transcript.
 */
export function withDesktopSessionModelTrace<T>(
  sessionsRootDir: string,
  sessionId: string,
  purpose: string,
  operation: () => T,
): T {
  let state: SessionState | undefined;
  try {
    const directory = lstatSync(sessionsRootDir);
    if (directory.isDirectory() && !directory.isSymbolicLink())
      state = new SessionManager(sessionsRootDir).readSessionState(sessionId);
  } catch {
    // Trace ownership lookup must neither create a missing store nor fail the helper.
  }
  const root = state?.workspace?.root ?? state?.cwd;
  const owner = usageOwnerFor(sessionsRootDir, sessionId, state, purpose);
  return withModelTraceContext(
    {
      storageDir: join(sessionsRootDir, ".model-traces"),
      sessionId,
      // A helper processing a different session must not borrow the caller's run.
      runId: undefined,
      parentSessionId: undefined,
      workspacePath: typeof root === "string" && isAbsolute(root) ? root : undefined,
      // Missing state cannot establish that a source is a durable work session.
      ephemeral: !state || state.ephemeral === true || sessionId.startsWith("qchat-"),
      source: "desktop-helper",
      purpose,
    },
    () => (owner ? withUsageOwner(owner, operation) : operation()),
  );
}

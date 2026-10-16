import { isAbsolute, join } from "node:path";
import { lstatSync } from "node:fs";
import { SessionManager, type SessionState } from "@cjhyy/code-shell-core";
import { withModelTraceContext } from "@cjhyy/code-shell-core/internal";

/** A helper's settings cwd is not necessarily the workspace of its source transcript. */
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
    operation,
  );
}

/**
 * Session storage roots and id validation.
 *
 * Owns where persisted Sessions live (`codeShellHome()` / `sessionsRoot()`,
 * including the test-runner guard that refuses the real ~/.code-shell store)
 * and the path-safety check every public SessionManager entry point applies
 * before joining a session id into that root.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { SessionError } from "../exceptions.js";
import { codeShellHome } from "../utils/paths.js";

/**
 * Validate a session ID before it is joined into a filesystem path.
 *
 * Internally generated IDs use `nanoid(16)` and are trusted by construction.
 * But every public entry point (`create`'s explicitSessionId, `resume`,
 * `exists`, `saveState`'s state.sessionId, `fork`'s sourceSessionId) accepts
 * an ID from an outside caller — protocol clients, ChatSessionManager-driven
 * cold starts, persisted state files — and join()'s it into `sessionsDir`.
 * Without this check a value like "../etc/passwd" or "/tmp/x" would let the
 * caller escape the sessions directory.
 *
 * Exported for direct unit testing.
 */
export function assertSafeSessionId(sessionId: unknown): asserts sessionId is string {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new SessionError(`invalid session id: must be a non-empty string`);
  }
  // basename check: reject any path-shaped value. Covers absolute paths,
  // POSIX and Windows separators, parent-dir tokens, and the lone "..".
  if (sessionId.includes("/") || sessionId.includes("\\")) {
    throw new SessionError(`invalid session id: contains path separator: ${sessionId}`);
  }
  if (sessionId === "." || sessionId === ".." || sessionId.includes("..")) {
    throw new SessionError(`invalid session id: contains parent-dir token: ${sessionId}`);
  }
  // Conservative character allow-list: letters, digits, and `-_.` only.
  // This matches what nanoid emits plus the dotted variants in-house code
  // already uses (e.g. "tui-main", "agent.foo"). Anything else (NUL,
  // newline, control chars, shell metacharacters, glob chars) is rejected.
  if (!/^[A-Za-z0-9_.-]+$/.test(sessionId)) {
    throw new SessionError(`invalid session id: unexpected characters: ${sessionId}`);
  }
  // Cap the length to keep filesystem APIs happy and avoid disk-name DoS.
  if (sessionId.length > 128) {
    throw new SessionError(`invalid session id: too long (max 128 chars)`);
  }
}

export { codeShellHome } from "../utils/paths.js";

/** True when this process is a test runner. `bun test` sets NODE_ENV itself. */
function isTestRunner(): boolean {
  return process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1";
}

/** The real per-user home, ignoring any CODE_SHELL_HOME override. */
function defaultHome(): string {
  return join(homedir(), ".code-shell");
}

/**
 * Canonical root for every persisted CodeShell session. An explicit `home`
 * (a `~/.code-shell`-equivalent data root) overrides the default resolution;
 * absent → `codeShellHome()` exactly as before.
 */
export function sessionsRoot(home?: string): string {
  const resolvedHome = home ?? codeShellHome();
  // Fail closed rather than write fixture sessions into the developer's real
  // store. The bunfig preload only applies when Bun resolves a bunfig.toml:
  // `bun test <file>` from a subdirectory, or an IDE/CI runner with its own
  // cwd, finds none and silently fell through to ~/.code-shell — which is how
  // ~700 `test-model` sessions ended up in the real store and the sidebar.
  //
  // Guarded here rather than in codeShellHome() because the home is also the
  // legitimate root for settings/projects/trust that many tests read by
  // design; only the SESSIONS root is the one tests corrupt.
  if (isTestRunner() && resolvedHome === defaultHome()) {
    // Prefer the preload's sandbox. Many test files delete CODE_SHELL_HOME in
    // cleanup, and bun shares one process across files, so isolation would
    // otherwise vanish for every later suite.
    const sandbox = process.env.CODE_SHELL_TEST_HOME;
    if (sandbox) return join(sandbox, "sessions");
    throw new SessionError(
      "Refusing to use the real ~/.code-shell/sessions from a test. Set CODE_SHELL_HOME " +
        "to a temp dir (packages/core/test-setup.ts does this via the bunfig preload) " +
        "or pass an explicit storageDir.",
    );
  }
  return join(resolvedHome, "sessions");
}

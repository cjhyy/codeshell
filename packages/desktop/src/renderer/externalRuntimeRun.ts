/**
 * Running one turn on an external Agent Runtime (Codex / Claude Code).
 *
 * The renderer treats these exactly like a model choice: the user picks
 * `codex/gpt-5.1` from the ordinary dropdown and sends. This module is the only
 * place that knows the turn goes somewhere else, and it exists to make the
 * external path return the SAME shape as `window.codeshell.run`, so the caller's
 * bookkeeping — busy clearing, error surfacing, logging — stays shared.
 *
 * Duplicating that bookkeeping is how one path ends up permanently stuck
 * "busy" after a failure the other path handles, so the seam is deliberately
 * this narrow.
 */

/** The subset of the preload surface this needs. Injected for testability. */
export interface ExternalRuntimeBridge {
  start(payload: {
    sessionId: string;
    cwd: string;
    modelKey: string;
  }): Promise<{ kind: string; runtimeSessionId: string | null; tools: string[] }>;
  send(payload: { sessionId: string; text: string }): Promise<void>;
}

export interface ExternalRuntimeTurnArgs {
  sessionId: string;
  cwd: string;
  modelKey: string;
  text: string;
  runtime: ExternalRuntimeBridge;
}

/**
 * Mirrors the engine's RunResult closely enough for the shared `.then` handler:
 * it reads `ok`/`reason`/`text` to decide whether to surface an early failure.
 */
export interface ExternalRuntimeRunResult {
  ok: boolean;
  reason?: string;
  text?: string;
}

/**
 * Sessions already started on this runtime, so a follow-up turn does not
 * restart the process and lose its context.
 *
 * Keyed by session id. `start` is idempotent in the service (it closes and
 * replaces), which is exactly what must NOT happen mid-conversation: a restart
 * would drop the runtime's own thread and the user would silently lose history.
 *
 * ## Deliberately in-memory: what an app restart does
 *
 * The model CHOICE survives a restart (`modelOverrides` is persisted to
 * localStorage), so reopening the session still routes to Codex. What does not
 * survive is the runtime's own conversation thread — this map is empty, so the
 * next turn starts a fresh backend and the model no longer remembers the
 * earlier exchange, even though CodeShell's transcript still displays it.
 *
 * That gap is not fixable by persisting this map: the runtime processes are
 * gone too, and only Claude Code exposes a resume handle (`--resume`), which is
 * itself scoped to a live process. Genuine cross-restart resume needs the
 * runtime session id durably stored and re-attached at startup — ADR 1 in the
 * design doc. Until then the honest behaviour is a clean restart rather than a
 * silently truncated context, which is what this does.
 */
const startedSessions = new Map<string, string>();

/** Forget a session's runtime binding (session deleted, or runtime stopped). */
export function forgetExternalRuntimeSession(sessionId: string): void {
  startedSessions.delete(sessionId);
}

/** Test seam — the module-level cache would otherwise leak between cases. */
export function resetExternalRuntimeSessions(): void {
  startedSessions.clear();
}

/**
 * Start the session if needed, then send one turn.
 *
 * Resolves when the turn completes, matching `agent/run`: the caller treats
 * resolution as "the turn is over", and resolving early would clear busy while
 * the model is still streaming.
 */
export async function runExternalRuntimeTurn({
  sessionId,
  cwd,
  modelKey,
  text,
  runtime,
}: ExternalRuntimeTurnArgs): Promise<ExternalRuntimeRunResult> {
  try {
    // Restart only when the model actually changed. Switching Codex → Claude
    // mid-session has to rebuild the backend; re-sending on the same one must
    // not, or every turn would begin with an empty context.
    if (startedSessions.get(sessionId) !== modelKey) {
      await runtime.start({ sessionId, cwd, modelKey });
      startedSessions.set(sessionId, modelKey);
    }
    await runtime.send({ sessionId, text });
    return { ok: true };
  } catch (error) {
    // A failed start leaves no usable session — drop the binding so the next
    // attempt retries the start instead of sending into a runtime that is not
    // there.
    startedSessions.delete(sessionId);
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "external_runtime_error", text: message };
  }
}

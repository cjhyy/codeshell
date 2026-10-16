import type { SessionState } from "../types.js";
import { isEphemeralSessionState } from "../session/session-manager.js";
import { recordModelTraceEvent, withModelTraceContext } from "../model-traces/context.js";
import type { EngineResult } from "./types.js";
import type { EngineRunOptions } from "./run-types.js";

/** One execution scope covers model calls, tools and its complete lifecycle. */
export function withEngineRunTrace(
  state: SessionState,
  cwd: string,
  runId: string,
  options: EngineRunOptions | undefined,
  operation: () => EngineResult | Promise<EngineResult>,
): Promise<EngineResult> {
  const signal = options?.signal;
  const source = options?.modelTraceSource;
  return withModelTraceContext(
    {
      workspacePath: cwd,
      sessionId: state.sessionId,
      runId,
      ephemeral: isEphemeralSessionState(state),
      ...(source && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/.test(source) ? { source } : {}),
    },
    async () => {
      const event = {
        id: runId,
        traceId: runId,
        runId,
        sessionId: state.sessionId,
        kind: "lifecycle" as const,
        name: "execution",
        startedAt: Date.now(),
      };
      recordModelTraceEvent({ ...event, status: "running", first: true });
      try {
        const result = await operation();
        recordModelTraceEvent({ ...event, endedAt: Date.now(), status: result.reason });
        return result;
      } catch (error) {
        recordModelTraceEvent({
          ...event,
          endedAt: Date.now(),
          status: signal?.aborted ? "cancelled" : "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  );
}

/** Unknown source state cannot supply workspace authority or clear inherited privacy. */
export function withEngineAuxiliaryModelTrace<T>(
  state: SessionState | undefined,
  purpose: string,
  operation: () => T,
  attribution?: { sessionId?: string; workspacePath?: string },
): T {
  return withModelTraceContext(
    {
      sessionId: state?.sessionId,
      workspacePath: state?.workspace?.root ?? state?.cwd,
      ...(state ? { ephemeral: isEphemeralSessionState(state) } : {}),
      purpose,
      ...attribution,
    },
    operation,
  );
}

/**
 * Persistent Goal controls on the preload bridge. Every method is a typed
 * agent/* RPC; persistence, revision fencing and authorization stay in the
 * worker/main handlers. Extracted from preload/index.ts and types.d.ts so the
 * declaration and implementation of one contract live together.
 */
import { rpcResult } from "./rpc-result";

type Rpc = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

/** Goal-level accounting persisted with the goal (Codex `time_used`-style). */
export interface GoalProgressSnapshot {
  /** Judged attempts across every run of this goal. */
  rounds: number;
  /** Settled running + background-wait time; paused and user-wait time excluded. */
  activeMs: number;
  /** Set while parked on background work: the goal clock runs since then. */
  runningSinceMs?: number;
}

export interface GoalControlApi {
  /**
   * Extend a running goal's turn / budget ceilings mid-run (TODO 3.1). Returns
   * the resulting effective limits; rejects if there's no active run.
   */
  goalExtend(
    sessionId: string,
    opts: {
      addTurns?: number;
      addTokenBudget?: number;
      addTimeBudgetMs?: number;
      addStopBlocks?: number;
    },
  ): Promise<{
    ok: boolean;
    limits: {
      maxTurns: number;
      tokenBudget?: number;
      timeBudgetMs?: number;
      maxStopBlocks: number;
    };
  }>;
  /** Clear a session's persisted active goal (CC /goal clear). */
  goalClear(sessionId: string): Promise<{ ok: boolean; cleared: boolean }>;
  /** Edit or pause/resume a session's persisted active goal. */
  goalUpdate(
    sessionId: string,
    update: {
      objective?: string;
      paused?: boolean;
      expectedGoalId: string;
      expectedRevision: number;
    },
  ): Promise<{
    ok: boolean;
    updated: boolean;
    goal?: string;
    goalId?: string;
    paused?: boolean;
    revision?: number;
  }>;
  /** Delete a session's persisted active goal. `goalClear` remains for compatibility. */
  goalDelete(
    sessionId: string,
    expected: { expectedGoalId: string; expectedRevision: number },
  ): Promise<{ ok: boolean; deleted: boolean }>;
  /**
   * Read a session's persisted active goal objective (or null when none), so
   * the goal block + edit/pause/delete controls can be restored on load — a
   * persistent goal isn't replayed from the transcript, so a reloaded session
   * would otherwise show nothing.
   */
  goalGet(sessionId: string): Promise<{
    ok: boolean;
    goal: string | null;
    goalId?: string;
    paused?: boolean;
    revision?: number;
    /** When the objective was set (epoch ms). */
    setAtMs?: number;
    /** Goal-level rounds and goal time; absent from older hosts. */
    progress?: GoalProgressSnapshot;
  }>;
}

export function createGoalControlApi(rpc: Rpc): GoalControlApi {
  const call = <T>(method: string, params: Record<string, unknown>) =>
    rpc(method, params).then((msg) => rpcResult<T>(msg));
  return {
    goalExtend: (sessionId, opts) => call("agent/goalExtend", { sessionId, ...opts }),
    goalClear: (sessionId) => call("agent/goalClear", { sessionId }),
    goalUpdate: (sessionId, update) => call("agent/goalUpdate", { sessionId, ...update }),
    goalDelete: (sessionId, expected) => call("agent/goalDelete", { sessionId, ...expected }),
    goalGet: (sessionId) => call("agent/goalGet", { sessionId }),
  };
}

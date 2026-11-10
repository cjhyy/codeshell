import type { PetAttentionOptions } from "./pet-notice-types.js";
import type {
  DesktopPetProjectionEvent,
  DesktopPetProjectionSnapshot,
  DesktopPetSession,
} from "./pet-state-aggregator.js";

/** What the notice wiring reads from the pet projection (PetStateAggregator). */
export interface PetNoticeProjectionView {
  snapshot(): DesktopPetProjectionSnapshot;
  /** Not a missed snapshot: the worker was reclaimed, or none is alive. */
  workerIsGone(state: DesktopPetProjectionSnapshot["workerState"]): boolean;
  /** The top-level, non-external work Session with this id, if the projection lists it. */
  workSession(sessionId: string): DesktopPetSession | undefined;
  /** A top-level work Session (not Mimi's, not external) that rules may watch. */
  isEligibleSession(sessionId: string): boolean;
  /** Whether a decision still waits; a missed snapshot never says it was resolved. */
  isDecisionStillPending(sessionId: string, requestId: string): boolean;
}

export function createNoticeProjectionView(options: {
  projection: PetAttentionOptions["source"];
  hasLiveWorker?: () => boolean;
  isMimiSession?: (sessionId: string) => boolean;
}): PetNoticeProjectionView {
  const snapshot = (): DesktopPetProjectionSnapshot => options.projection.getSnapshot();
  const workSession = (sessionId: string) =>
    snapshot().sessions.find(
      (session) => session.agentSessionId === sessionId && !session.external,
    );
  return {
    snapshot,
    workerIsGone: (state) =>
      state === "reclaimed" || (state === "disconnected" && options.hasLiveWorker?.() === false),
    workSession,
    // The projection only lists top-level work Sessions (no Mimi, child or hidden kinds).
    isEligibleSession: (sessionId) =>
      options.isMimiSession?.(sessionId) !== true && workSession(sessionId) !== undefined,
    isDecisionStillPending: (sessionId, requestId) => {
      const current = snapshot();
      // A missed snapshot empties the pending list while the worker may be
      // alive: only a live snapshot without the decision says it was resolved.
      if (current.workerState !== "active") return true;
      return current.pending.some(
        (pending) =>
          pending.agentSessionId === sessionId &&
          pending.requestId === requestId &&
          pending.status === "pending",
      );
    },
  };
}

/**
 * The worker that drove the Sessions' runs is gone, so those runs never
 * close: their parked reports go out (as "no reply forwarded"). The
 * aggregator reports a loss as a reset whose snapshot names the state, and
 * also reads one failed snapshot as "disconnected" while the worker may be
 * alive. Gone means: reclaimed, no live worker, or the next live snapshot
 * comes from another worker generation.
 */
export function createWorkerLossDetector(
  view: Pick<PetNoticeProjectionView, "snapshot" | "workerIsGone">,
): (event: DesktopPetProjectionEvent) => boolean {
  let suspectGeneration: number | undefined;
  return (event) => {
    if (event.kind !== "reset" && event.kind !== "worker-state") return false;
    const current = view.snapshot();
    const state = event.kind === "worker-state" ? event.state : current.workerState;
    if (state === "disconnected" || state === "reclaimed") {
      if (view.workerIsGone(state)) {
        suspectGeneration = undefined;
        return true;
      }
      suspectGeneration ??= current.generation;
      return false;
    }
    if (state !== "active" || suspectGeneration === undefined) return false;
    const replaced = current.generation !== suspectGeneration;
    suspectGeneration = undefined;
    return replaced;
  };
}

/** A decision answered anywhere (or timed out), from one projection event. */
export function resolvedDecision(
  event: DesktopPetProjectionEvent,
): { sessionId: string; requestId: string } | undefined {
  if (event.kind === "pending-remove")
    return { sessionId: event.sessionId, requestId: event.requestId };
  if (event.kind === "pending-upsert" && event.pending.status !== "pending")
    return { sessionId: event.pending.agentSessionId, requestId: event.pending.requestId };
  return undefined;
}

import type {
  PetPendingDecision,
  PetProjectionSnapshot,
  PetSessionProjection,
} from "../../preload/types";
import type { PetProjectionStatus } from "./petStateReducer";
import {
  sessionDisplayState,
  type PetSessionDisplayState,
  type PetSessionEmptyState,
} from "./SessionStatusSection";

const STALE_AFTER_MS = 5 * 60_000;

const DISPLAY_ORDER: Record<PetSessionDisplayState, number> = {
  waiting: 0,
  running: 1,
  queued: 2,
  idle: 3,
  dormant: 3,
  terminal: 4,
  unknown: 5,
};

export interface PetOverviewSelection {
  sessions: PetSessionProjection[];
  pending: PetPendingDecision[];
  runningCount: number;
  queuedCount: number;
  pendingCount: number;
  emptyState: PetSessionEmptyState;
  stale: boolean;
}

function selectEmptyState(
  snapshot: PetProjectionSnapshot | null,
  status: PetProjectionStatus,
  stale: boolean,
): PetSessionEmptyState {
  if (!snapshot || status === "loading") return "loading";
  if (status === "reconciling" || snapshot.workerState === "reconciling") return "reconciling";
  if (snapshot.workerState === "disconnected") return "disconnected";
  if (stale) return "stale";
  if (snapshot.workerState === "reclaimed") return "reclaimed";
  return "empty";
}

export function selectPetOverview(
  snapshot: PetProjectionSnapshot | null,
  status: PetProjectionStatus,
  now = Date.now(),
): PetOverviewSelection {
  if (!snapshot) {
    return {
      sessions: [],
      pending: [],
      runningCount: 0,
      queuedCount: 0,
      pendingCount: 0,
      emptyState: "loading",
      stale: false,
    };
  }

  const stale = snapshot.workerState !== "reclaimed" && now - snapshot.observedAt > STALE_AFTER_MS;
  const sessions = [...snapshot.sessions].sort((left, right) => {
    const stateDelta =
      DISPLAY_ORDER[sessionDisplayState(left)] - DISPLAY_ORDER[sessionDisplayState(right)];
    if (stateDelta !== 0) return stateDelta;
    return (
      right.lastActivityAt - left.lastActivityAt ||
      left.agentSessionId.localeCompare(right.agentSessionId)
    );
  });
  const pending = snapshot.pending
    .filter((decision) => decision.status === "pending")
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.requestId.localeCompare(right.requestId),
    );

  return {
    sessions,
    pending,
    runningCount: sessions.filter((session) => session.runState === "running").length,
    queuedCount: sessions.filter((session) => session.runState === "queued").length,
    pendingCount: pending.length,
    emptyState: selectEmptyState(snapshot, status, stale),
    stale,
  };
}

/**
 * Stable Pet projection wire contract for host bridges and UI clients.
 *
 * State-machine implementations remain package-private; this entry contains
 * only method names and the shapes crossing the host boundary.
 */
export {
  GET_PET_PROJECTION_SNAPSHOT_METHOD,
  PET_PROJECTION_DELTA_METHOD,
  PET_REPORT_TO_MIMI_METHOD,
  type PetProjectionDelta,
  type PetProjectionSnapshotResult,
  type PetReportToMimiEvent,
} from "./protocol.js";
export {
  LOCAL_PET_OWNER,
  type PendingDecisionKind,
  type PendingDecisionProjection,
  type PendingDecisionStatus,
  type PetOwnerId,
  type PetProjectionCursor,
  type PetProjectionFreshness,
  type PetProjectionSnapshot,
  type PetSessionPhase,
  type PetSessionProjection,
  type PetSessionRunState,
  type PetTerminalStatus,
  type PetWorkerState,
} from "./types.js";

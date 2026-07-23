/**
 * Wire shapes for the Pet projection RPC surface. Deltas are pushed by the
 * worker-side projection extension over the legacy notification method name
 * `agent/petProjectionDelta`; the snapshot answers
 * `agent/getPetProjectionSnapshot`. (Method names stay stable for the desktop
 * bridge, which intercepts them by name.)
 */

import type {
  PendingDecisionProjection,
  PetProjectionSnapshot,
  PetSessionProjection,
  PetWorkerState,
} from "./types.js";

export type PetProjectionDelta =
  | {
      workerGeneration: number;
      version: number;
      observedAt: number;
      kind: "session-upsert";
      session: PetSessionProjection;
    }
  | {
      workerGeneration: number;
      version: number;
      observedAt: number;
      kind: "session-remove";
      sessionId: string;
    }
  | {
      workerGeneration: number;
      version: number;
      observedAt: number;
      kind: "pending-upsert";
      pending: PendingDecisionProjection;
    }
  | {
      workerGeneration: number;
      version: number;
      observedAt: number;
      kind: "pending-remove";
      sessionId: string;
      requestId: string;
      status: Exclude<PendingDecisionProjection["status"], "pending">;
    }
  | {
      workerGeneration: number;
      version: number;
      observedAt: number;
      kind: "worker-state";
      state: PetWorkerState;
    };

export type PetProjectionSnapshotResult = PetProjectionSnapshot;

/** Any Session → host report routed to Mimi without revealing her hidden Session id. */
export interface PetReportToMimiEvent {
  reportId: string;
  sessionId: string;
  message: string;
  attachmentPaths?: string[];
  createdAt: number;
}

/**
 * Wire method names, kept byte-identical to the pre-extraction core protocol
 * so the desktop bridge (which intercepts by name) needs no changes. Core's
 * Methods table retains the same strings as a compat surface.
 */
export const PET_PROJECTION_DELTA_METHOD = "agent/petProjectionDelta";
export const GET_PET_PROJECTION_SNAPSHOT_METHOD = "agent/getPetProjectionSnapshot";
export const PET_REPORT_TO_MIMI_METHOD = "agent/petReportToMimi";

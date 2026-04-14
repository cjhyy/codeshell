/**
 * RunStore — persistence interface for Run lifecycle data.
 *
 * Implementations must guarantee:
 *   - Snapshot writes are atomic (no partial state on crash)
 *   - Event appends are append-only and ordered
 *   - Checkpoint / approval reads return the latest version
 */

import type {
  RunSnapshot,
  RunEvent,
  RunCheckpoint,
  RunApproval,
  RunArtifactRef,
  ListRunsQuery,
} from "./types.js";

export interface RunStore {
  // ─── Snapshot ────────────────────────────────────────────────────
  create(snapshot: RunSnapshot): Promise<void>;
  update(snapshot: RunSnapshot): Promise<void>;
  get(runId: string): Promise<RunSnapshot | null>;
  list(query?: ListRunsQuery): Promise<RunSnapshot[]>;
  delete(runId: string): Promise<void>;

  // ─── Events ──────────────────────────────────────────────────────
  appendEvent(event: RunEvent): Promise<void>;
  listEvents(runId: string): Promise<RunEvent[]>;

  // ─── Checkpoints ─────────────────────────────────────────────────
  saveCheckpoint(cp: RunCheckpoint): Promise<void>;
  getLatestCheckpoint(runId: string): Promise<RunCheckpoint | null>;

  // ─── Approvals ───────────────────────────────────────────────────
  saveApproval(approval: RunApproval): Promise<void>;
  getApproval(runId: string, approvalId: string): Promise<RunApproval | null>;
  getPendingApproval(runId: string): Promise<RunApproval | null>;

  // ─── Artifact Refs ───────────────────────────────────────────────
  appendArtifactRef(ref: RunArtifactRef): Promise<void>;
  listArtifactRefs(runId: string): Promise<RunArtifactRef[]>;
}

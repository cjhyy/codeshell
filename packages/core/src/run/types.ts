/**
 * Run — managed lifecycle types for long-running agent tasks.
 *
 * A Run wraps one or more Engine executions with queue, state machine,
 * checkpoint, approval, and artifact tracking.
 */

import type { AgentPresetName } from "../preset/index.js";

// ─── Run Status ──────────────────────────────────────────────────

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

// ─── Run Snapshot ────────────────────────────────────────────────

export interface RunSnapshot {
  runId: string;
  objective: string;
  preset: AgentPresetName;
  cwd: string;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  parentRunId: string | null;
  sessionId: string | null;
  childSessionIds: string[];
  attemptCount: number;
  latestCheckpointId: string | null;
  latestApprovalId: string | null;
  summary: string | null;
  error: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
}

// ─── Run Events ──────────────────────────────────────────────────

export type RunEventType =
  | "run_created"
  | "run_queued"
  | "run_started"
  | "session_linked"
  | "checkpoint_written"
  | "artifact_recorded"
  | "approval_requested"
  | "approval_resolved"
  | "run_blocked"
  | "run_resumed"
  | "run_completed"
  | "run_failed"
  | "run_cancelled";

export interface RunEvent {
  eventId: string;
  runId: string;
  type: RunEventType;
  timestamp: number;
  data: Record<string, unknown>;
}

// ─── Checkpoint ──────────────────────────────────────────────────

export interface RunCheckpoint {
  checkpointId: string;
  runId: string;
  createdAt: number;
  phase: string;
  objective: string;
  summary: string;
  nextAction: string | null;
  linkedSessionId: string | null;
  touchedTools: string[];
  touchedArtifacts: string[];
  waitingFor:
    | null
    | { kind: "input"; prompt: string }
    | { kind: "approval"; approvalId: string };
  evaluator:
    | null
    | {
        status: "pending" | "passed" | "failed";
        findings: string[];
      };
  metadata: Record<string, unknown>;
}

// ─── Approval ────────────────────────────────────────────────────

export type ApprovalStatus = "pending" | "approved" | "rejected";

export type ApprovalCategory =
  | "tool"
  | "artifact_publish"
  | "workflow_transition"
  | "custom";

export interface RunApproval {
  approvalId: string;
  runId: string;
  createdAt: number;
  resolvedAt: number | null;
  status: ApprovalStatus;
  category: ApprovalCategory;
  title: string;
  description: string;
  payload: Record<string, unknown>;
}

// ─── Artifact Ref ────────────────────────────────────────────────

export type ArtifactKind =
  | "file"
  | "document"
  | "diagram"
  | "prototype"
  | "resource"
  | "custom";

export type ArtifactRole = "input" | "output" | "checkpoint" | "supporting";

export interface RunArtifactRef {
  artifactRefId: string;
  runId: string;
  kind: ArtifactKind;
  title: string;
  locator: string;
  role: ArtifactRole;
  version: string | null;
  metadata: Record<string, unknown>;
}

// ─── Input / Query Types ─────────────────────────────────────────

export interface SubmitRunInput {
  objective: string;
  preset?: AgentPresetName;
  cwd?: string;
  parentRunId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface ResumeRunInput {
  userInput?: string;
  approvalDecision?: { approvalId: string; approved: boolean; reason?: string };
}

export interface ListRunsQuery {
  status?: RunStatus | RunStatus[];
  tag?: string;
  limit?: number;
  offset?: number;
}

// ─── Execution Context (EngineRunner) ────────────────────────────

export interface RunExecutionContext {
  onStream?: import("../types.js").StreamCallback;
  signal?: AbortSignal;
  engineConfigOverrides?: Record<string, unknown>;
}

export interface RunExecutionResult {
  text: string;
  reason: import("../types.js").TerminalReason;
  sessionId: string;
  turnCount: number;
}

// ─── Stream / Attach ─────────────────────────────────────────────

export type RunStreamEvent =
  | { type: "run_status_changed"; run: RunSnapshot }
  | { type: "run_event"; event: RunEvent }
  | { type: "engine_stream"; event: import("../types.js").StreamEvent };

export type RunStreamCallback = (event: RunStreamEvent) => void | Promise<void>;

export type DetachFn = () => void;

// ─── State Machine ───────────────────────────────────────────────

/**
 * Valid state transitions for a Run.
 * Key = current status, Value = allowed next statuses.
 */
export const VALID_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  queued: ["running", "cancelled"],
  running: [
    "waiting_input",
    "waiting_approval",
    "blocked",
    "completed",
    "failed",
    "cancelled",
  ],
  waiting_input: ["queued", "cancelled"],
  waiting_approval: ["queued", "cancelled"],
  blocked: ["queued", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

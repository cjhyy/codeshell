/**
 * Run module — managed agent run lifecycle.
 */

// Types
export type {
  RunStatus,
  RunSnapshot,
  RunEventType,
  RunEvent,
  RunCheckpoint,
  ApprovalStatus,
  ApprovalCategory,
  RunApproval,
  ArtifactKind,
  ArtifactRole,
  RunArtifactRef,
  SubmitRunInput,
  ResumeRunInput,
  ListRunsQuery,
  RunExecutionContext,
  RunExecutionResult,
  RunStreamEvent,
  RunStreamCallback,
  DetachFn,
} from "./types.js";
export { VALID_TRANSITIONS } from "./types.js";

// Store
export type { RunStore } from "./RunStore.js";
export { FileRunStore } from "./FileRunStore.js";

// Queue
export { RunQueue } from "./RunQueue.js";

// Approval / Input adapters
export {
  RunApprovalBackend,
  createRunAskUserFn,
  type RunLifecycleHooks,
  type PendingApproval,
  type PendingInput,
} from "./RunApprovalBackend.js";

// Checkpoint & Artifacts
export { CheckpointWriter, type CheckpointWriterConfig } from "./CheckpointWriter.js";
export { ArtifactTracker, type ArtifactTrackerConfig } from "./ArtifactTracker.js";

// Hardening
export { RunLock, type RunLockConfig } from "./RunLock.js";
export { Heartbeat, type HeartbeatConfig, type HeartbeatData } from "./Heartbeat.js";

// Evaluator
export {
  NoopEvaluator,
  CompositeEvaluator,
  type Evaluator,
  type EvaluatorResult,
  type EvaluatorVerdict,
  type EvaluatorContext,
} from "./Evaluator.js";

// Runner
export {
  EngineRunner,
  type EngineRunnerConfig,
  type RunExecutionHandle,
  type RunExecutor,
  type CustomToolEntry,
} from "./EngineRunner.js";

// Manager
export { RunManager, type RunManagerConfig } from "./RunManager.js";

// Factory
export { createRunManager, type CreateRunManagerOptions } from "./factory.js";

/**
 * Durable Pet long-task domain model.
 *
 * The package owns the state machine and the bounded context contract. Hosts
 * own persistence, worker control, and UI transport. Keeping those effects out
 * of this module lets Desktop and a future headless host share identical task
 * semantics without teaching core about Pet.
 */

import type { PetWorkExecutionBackend } from "./delegation.js";

export const PET_LONG_TASK_SCHEMA_VERSION = 1 as const;
export const MAX_PET_LONG_TASK_EVENTS = 120;
export const MAX_PET_LONG_TASK_SUMMARY_LENGTH = 8_000;

export type PetLongTaskStatus =
  | "queued"
  | "running"
  | "waiting"
  | "paused"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled";

export type PetLongTaskPhase =
  | "planning"
  | "executing"
  | "waiting-user"
  | "waiting-worker"
  | "finalizing";

export type PetLongTaskVerificationMode = "turn" | "goal";

export interface PetLongTaskArtifact {
  kind: "session" | "result" | "file" | "url";
  label: string;
  /** Opaque host reference. The Pet package never dereferences it. */
  reference: string;
}

/** Host-owned delivery route for a proactive completion receipt. */
export interface PetLongTaskCompletionTarget {
  kind: "im-gateway";
  channel: string;
  target: string;
}

export type PetLongTaskEventKind =
  | "created"
  | "started"
  | "progress"
  | "waiting"
  | "paused"
  | "resumed"
  | "retrying"
  | "artifact"
  | "checkpoint"
  | "verification-changed"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled"
  | "closure-decided"
  | "continuation-started"
  | "closure-recorded";

export interface PetLongTaskEvent {
  id: string;
  sequence: number;
  kind: PetLongTaskEventKind;
  at: number;
  message?: string;
  phase?: PetLongTaskPhase;
  waitingFor?: string;
  nextAction?: string;
  artifacts?: PetLongTaskArtifact[];
}

export interface PetLongTask {
  schemaVersion: typeof PET_LONG_TASK_SCHEMA_VERSION;
  id: string;
  originClientMessageId: string;
  objective: string;
  workspacePath: string | null;
  sessionId: string;
  /** Explicit external execution backend, when the user required one. */
  executionBackend?: PetWorkExecutionBackend;
  /** Ordinary final response, or persistent Goal verdict, required for closure. */
  verificationMode: PetLongTaskVerificationMode;
  completionTarget?: PetLongTaskCompletionTarget;
  /** Number of terminal-result decisions Mimi has autonomously continued. */
  continuationDepth?: number;
  status: PetLongTaskStatus;
  phase: PetLongTaskPhase;
  attempt: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  /** The current attempt's terminal outcome reached durable Pet work memory. */
  closureRecordedAt?: number;
  /** Durable Mimi closure decision, persisted before any continuation side effect. */
  closureDecision?: PetLongTaskClosureDecision;
  /** Latest assistant-authored result/checkpoint, kept separate from UI progress text. */
  resultSummary?: string;
  summary?: string;
  waitingFor?: string;
  nextAction?: string;
  lastError?: string;
  artifacts: PetLongTaskArtifact[];
  events: PetLongTaskEvent[];
}

export interface PetLongTaskContinuationDecision {
  clientMessageId: string;
  objective: string;
  workspacePath: string | null;
  executionBackend?: PetWorkExecutionBackend;
}

export interface PetLongTaskClosureDecision {
  key: string;
  text: string;
  decidedAt: number;
  continuation?: PetLongTaskContinuationDecision;
  launch?: { sessionId: string; taskId?: string; at: number };
}

export interface PetLongTaskSnapshot {
  revision: number;
  observedAt: number;
  tasks: PetLongTask[];
}

export type PetLongTaskControlAction = "pause" | "resume" | "retry" | "cancel";

export interface PetLongTaskControlRequest {
  taskId: string;
  action: PetLongTaskControlAction;
}

export type PetLongTaskControlResult =
  | { ok: true; task: PetLongTask }
  | { ok: false; code: "not-found" | "invalid-state" | "worker-error"; message: string };

export interface CreatePetLongTaskInput {
  id: string;
  originClientMessageId: string;
  objective: string;
  workspacePath: string | null;
  sessionId: string;
  executionBackend?: PetWorkExecutionBackend;
  verificationMode?: PetLongTaskVerificationMode;
  completionTarget?: PetLongTaskCompletionTarget;
  continuationDepth?: number;
  at: number;
}

export type PetLongTaskTransition =
  | { kind: "started"; at: number; message?: string }
  | { kind: "progress"; at: number; phase: PetLongTaskPhase; summary: string }
  | { kind: "waiting"; at: number; waitingFor: string; message?: string }
  | { kind: "paused"; at: number; reason?: string }
  | { kind: "resumed"; at: number; message?: string }
  | { kind: "retrying"; at: number; reason?: string }
  | { kind: "artifact"; at: number; artifacts: PetLongTaskArtifact[] }
  | {
      kind: "checkpoint";
      at: number;
      summary: string;
      nextAction?: string;
      artifacts?: PetLongTaskArtifact[];
    }
  | { kind: "verification-changed"; at: number; mode: PetLongTaskVerificationMode }
  | { kind: "interrupted"; at: number; reason: string }
  | {
      kind: "completed";
      at: number;
      summary?: string;
      artifacts?: PetLongTaskArtifact[];
    }
  | { kind: "failed"; at: number; error: string; summary?: string }
  | { kind: "cancelled"; at: number; reason?: string }
  | {
      kind: "closure-decided";
      at: number;
      key: string;
      text: string;
      continuation?: PetLongTaskContinuationDecision;
    }
  | {
      kind: "continuation-started";
      at: number;
      key: string;
      sessionId: string;
      taskId?: string;
    }
  | { kind: "closure-recorded"; at: number };

const TERMINAL = new Set<PetLongTaskStatus>(["completed", "failed", "cancelled"]);

function bounded(value: string | undefined, maximum: number): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > maximum ? `${normalized.slice(0, maximum - 1)}…` : normalized;
}

function normalizeCompletionTarget(value: unknown): PetLongTaskCompletionTarget | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const channel = typeof record.channel === "string" ? record.channel.trim().toLowerCase() : "";
  const target = typeof record.target === "string" ? record.target.trim() : "";
  if (
    record.kind !== "im-gateway" ||
    !/^[a-z0-9_-]{1,32}$/u.test(channel) ||
    !target ||
    target.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(target)
  ) {
    return undefined;
  }
  return { kind: "im-gateway", channel, target };
}

function normalizeArtifacts(
  value: readonly PetLongTaskArtifact[] | undefined,
): PetLongTaskArtifact[] {
  if (!value) return [];
  const seen = new Set<string>();
  const artifacts: PetLongTaskArtifact[] = [];
  for (const artifact of value) {
    if (!artifact || !["session", "result", "file", "url"].includes(artifact.kind)) continue;
    const label = bounded(artifact.label, 160);
    const reference = bounded(artifact.reference, 2_048);
    if (!label || !reference) continue;
    const key = `${artifact.kind}\u0000${reference}`;
    if (seen.has(key)) continue;
    seen.add(key);
    artifacts.push({ kind: artifact.kind, label, reference });
    if (artifacts.length >= 24) break;
  }
  return artifacts;
}

function mergeArtifacts(
  current: readonly PetLongTaskArtifact[],
  incoming: readonly PetLongTaskArtifact[] | undefined,
): PetLongTaskArtifact[] {
  return normalizeArtifacts([...current, ...(incoming ?? [])]);
}

function appendEvent(
  task: PetLongTask,
  input: Omit<PetLongTaskEvent, "id" | "sequence">,
): PetLongTaskEvent[] {
  const sequence = (task.events.at(-1)?.sequence ?? 0) + 1;
  const event: PetLongTaskEvent = {
    ...input,
    id: `${task.id}:${sequence}`,
    sequence,
    message: bounded(input.message, 2_000),
    waitingFor: bounded(input.waitingFor, 500),
    nextAction: bounded(input.nextAction, 500),
    artifacts: input.artifacts ? normalizeArtifacts(input.artifacts) : undefined,
  };
  return [...task.events, event].slice(-MAX_PET_LONG_TASK_EVENTS);
}

export function createPetLongTask(input: CreatePetLongTaskInput): PetLongTask {
  const id = bounded(input.id, 128);
  const originClientMessageId = bounded(input.originClientMessageId, 256);
  const objective = bounded(input.objective, 8_000);
  const sessionId = bounded(input.sessionId, 256);
  if (!id || !originClientMessageId || !objective || !sessionId) {
    throw new Error("invalid Pet long-task identity or objective");
  }
  const workspacePath = input.workspacePath ? bounded(input.workspacePath, 4_096) : null;
  const completionTarget = normalizeCompletionTarget(input.completionTarget);
  const continuationDepth =
    typeof input.continuationDepth === "number" &&
    Number.isSafeInteger(input.continuationDepth) &&
    input.continuationDepth > 0
      ? input.continuationDepth
      : 0;
  const created: PetLongTaskEvent = {
    id: `${id}:1`,
    sequence: 1,
    kind: "created",
    at: input.at,
    message: "Long-running work accepted and queued",
    phase: "planning",
    nextAction: "Start the work session",
  };
  return {
    schemaVersion: PET_LONG_TASK_SCHEMA_VERSION,
    id,
    originClientMessageId,
    objective,
    workspacePath: workspacePath ?? null,
    sessionId,
    ...(input.executionBackend === "codex" ? { executionBackend: "codex" as const } : {}),
    verificationMode: input.verificationMode === "goal" ? "goal" : "turn",
    ...(completionTarget ? { completionTarget } : {}),
    ...(continuationDepth > 0 ? { continuationDepth } : {}),
    status: "queued",
    phase: "planning",
    attempt: 1,
    revision: 1,
    createdAt: input.at,
    updatedAt: input.at,
    nextAction: "Start the work session",
    artifacts: [{ kind: "session", label: "Work session", reference: sessionId }],
    events: [created],
  };
}

/**
 * Apply one durable transition. Terminal tasks only accept retry/cancel or a
 * closure-delivery acknowledgement; late
 * worker events are ignored so a stale completion cannot undo an explicit user
 * action such as pause or cancel.
 */
export function transitionPetLongTask(
  current: PetLongTask,
  transition: PetLongTaskTransition,
): PetLongTask {
  if (transition.kind === "closure-decided" && current.closureDecision?.key === transition.key) {
    return current;
  }
  if (
    transition.kind === "continuation-started" &&
    current.closureDecision?.key === transition.key &&
    current.closureDecision.launch
  ) {
    return current;
  }
  // Stream and projection observations are handled on separate async paths.
  // An older projection can therefore arrive after a newer assistant checkpoint;
  // never let that stale progress erase the final result we will notify with.
  if (
    transition.at < current.updatedAt &&
    (transition.kind === "started" ||
      transition.kind === "progress" ||
      transition.kind === "waiting" ||
      transition.kind === "resumed" ||
      transition.kind === "checkpoint" ||
      transition.kind === "interrupted")
  ) {
    return current;
  }
  if (
    TERMINAL.has(current.status) &&
    transition.kind !== "retrying" &&
    transition.kind !== "cancelled" &&
    transition.kind !== "closure-decided" &&
    transition.kind !== "continuation-started" &&
    transition.kind !== "closure-recorded"
  ) {
    return current;
  }
  if (
    current.status === "cancelled" &&
    transition.kind !== "retrying" &&
    transition.kind !== "closure-decided" &&
    transition.kind !== "continuation-started" &&
    transition.kind !== "closure-recorded"
  ) {
    return current;
  }

  const next: PetLongTask = {
    ...current,
    revision: current.revision + 1,
    updatedAt: Math.max(current.updatedAt, transition.at),
    events: current.events,
  };
  let event: Omit<PetLongTaskEvent, "id" | "sequence">;
  switch (transition.kind) {
    case "started":
      Object.assign(next, {
        status: "running",
        phase: "executing",
        startedAt: current.startedAt ?? transition.at,
        waitingFor: undefined,
        nextAction: "Continue until the objective is verified complete",
        lastError: undefined,
      });
      event = {
        kind: transition.kind,
        at: transition.at,
        phase: "executing",
        message: transition.message ?? "Work session started",
        nextAction: next.nextAction,
      };
      break;
    case "progress":
      Object.assign(next, {
        status: "running",
        phase: transition.phase,
        summary: bounded(transition.summary, MAX_PET_LONG_TASK_SUMMARY_LENGTH),
        waitingFor: undefined,
        nextAction: "Continue until the objective is verified complete",
      });
      event = {
        kind: transition.kind,
        at: transition.at,
        phase: transition.phase,
        message: next.summary,
        nextAction: next.nextAction,
      };
      break;
    case "waiting":
      Object.assign(next, {
        status: "waiting",
        phase: "waiting-user",
        waitingFor: bounded(transition.waitingFor, 500),
        nextAction: "Open the work session and resolve the pending decision",
      });
      event = {
        kind: transition.kind,
        at: transition.at,
        phase: "waiting-user",
        message: transition.message,
        waitingFor: next.waitingFor,
        nextAction: next.nextAction,
      };
      break;
    case "paused":
      Object.assign(next, {
        status: "paused",
        phase: "waiting-worker",
        waitingFor: bounded(transition.reason, 500) ?? "Paused by user",
        nextAction: "Resume when ready",
      });
      event = {
        kind: transition.kind,
        at: transition.at,
        phase: "waiting-worker",
        message: next.waitingFor,
        nextAction: next.nextAction,
      };
      break;
    case "resumed":
      Object.assign(next, {
        status: "running",
        phase: "executing",
        waitingFor: undefined,
        nextAction: "Continue from the latest durable checkpoint",
        lastError: undefined,
      });
      event = {
        kind: transition.kind,
        at: transition.at,
        phase: "executing",
        message: transition.message ?? "Long-running work resumed",
        nextAction: next.nextAction,
      };
      break;
    case "retrying":
      Object.assign(next, {
        status: "queued",
        phase: "planning",
        attempt: current.attempt + 1,
        completedAt: undefined,
        closureRecordedAt: undefined,
        closureDecision: undefined,
        waitingFor: undefined,
        nextAction: "Retry from the existing work session and checkpoint",
        lastError: undefined,
      });
      event = {
        kind: transition.kind,
        at: transition.at,
        phase: "planning",
        message: transition.reason ?? `Retry attempt ${next.attempt}`,
        nextAction: next.nextAction,
      };
      break;
    case "artifact":
      Object.assign(next, {
        artifacts: mergeArtifacts(current.artifacts, transition.artifacts),
      });
      event = {
        kind: transition.kind,
        at: transition.at,
        phase: next.phase,
        message: "Work session produced an artifact",
        artifacts: transition.artifacts,
      };
      break;
    case "checkpoint":
      Object.assign(next, {
        summary: bounded(transition.summary, MAX_PET_LONG_TASK_SUMMARY_LENGTH),
        resultSummary: bounded(transition.summary, MAX_PET_LONG_TASK_SUMMARY_LENGTH),
        nextAction: bounded(transition.nextAction, 500) ?? current.nextAction,
        artifacts: mergeArtifacts(current.artifacts, transition.artifacts),
      });
      event = {
        kind: transition.kind,
        at: transition.at,
        phase: next.phase,
        message: next.summary,
        nextAction: next.nextAction,
        artifacts: transition.artifacts,
      };
      break;
    case "verification-changed":
      Object.assign(next, { verificationMode: transition.mode });
      event = {
        kind: transition.kind,
        at: transition.at,
        phase: next.phase,
        message:
          transition.mode === "goal"
            ? "Completion now requires a verified Goal verdict"
            : "Completion now follows the ordinary Work Session result",
      };
      break;
    case "interrupted":
      Object.assign(next, {
        status: "interrupted",
        phase: "waiting-worker",
        waitingFor: bounded(transition.reason, 500),
        nextAction: "Resume from the durable work session",
      });
      event = {
        kind: transition.kind,
        at: transition.at,
        phase: "waiting-worker",
        message: next.waitingFor,
        nextAction: next.nextAction,
      };
      break;
    case "completed": {
      const resultSummary =
        bounded(transition.summary, MAX_PET_LONG_TASK_SUMMARY_LENGTH) ?? current.resultSummary;
      Object.assign(next, {
        status: "completed",
        phase: "finalizing",
        completedAt: transition.at,
        ...(resultSummary ? { resultSummary } : {}),
        summary: resultSummary ?? current.summary ?? "Objective completed",
        waitingFor: undefined,
        nextAction: undefined,
        lastError: undefined,
        artifacts: mergeArtifacts(current.artifacts, transition.artifacts),
      });
      event = {
        kind: transition.kind,
        at: transition.at,
        phase: "finalizing",
        message: next.summary,
        artifacts: transition.artifacts,
      };
      break;
    }
    case "failed":
      Object.assign(next, {
        status: "failed",
        phase: "finalizing",
        completedAt: transition.at,
        summary: bounded(transition.summary, MAX_PET_LONG_TASK_SUMMARY_LENGTH) ?? current.summary,
        waitingFor: undefined,
        nextAction: "Inspect the failure, then retry or cancel",
        lastError: bounded(transition.error, 2_000),
      });
      event = {
        kind: transition.kind,
        at: transition.at,
        phase: "finalizing",
        message: next.lastError,
        nextAction: next.nextAction,
      };
      break;
    case "cancelled":
      Object.assign(next, {
        status: "cancelled",
        phase: "finalizing",
        completedAt: transition.at,
        waitingFor: undefined,
        nextAction: undefined,
      });
      event = {
        kind: transition.kind,
        at: transition.at,
        phase: "finalizing",
        message: transition.reason ?? "Cancelled by user",
      };
      break;
    case "closure-decided": {
      const key = bounded(transition.key, 512);
      const text = transition.text.trim().slice(0, MAX_PET_LONG_TASK_SUMMARY_LENGTH);
      if (!key || !text) return current;
      const continuation = transition.continuation;
      const normalizedContinuation = continuation
        ? {
            clientMessageId: continuation.clientMessageId.slice(0, 256),
            objective: continuation.objective.trim().slice(0, 8_000),
            workspacePath:
              typeof continuation.workspacePath === "string"
                ? continuation.workspacePath.slice(0, 4_096)
                : null,
            ...(continuation.executionBackend === "codex"
              ? { executionBackend: "codex" as const }
              : {}),
          }
        : undefined;
      if (
        normalizedContinuation &&
        (!normalizedContinuation.clientMessageId || !normalizedContinuation.objective)
      ) {
        return current;
      }
      Object.assign(next, {
        closureDecision: {
          key,
          text,
          decidedAt: transition.at,
          ...(normalizedContinuation ? { continuation: normalizedContinuation } : {}),
        },
      });
      event = {
        kind: transition.kind,
        at: transition.at,
        phase: current.phase,
        message: normalizedContinuation
          ? "Mimi recorded a durable continuation decision"
          : "Mimi recorded a durable closure reply",
      };
      break;
    }
    case "continuation-started": {
      if (
        current.closureDecision?.key !== transition.key ||
        !current.closureDecision.continuation
      ) {
        return current;
      }
      const sessionId = transition.sessionId.trim().slice(0, 256);
      if (!sessionId) return current;
      Object.assign(next, {
        closureDecision: {
          ...current.closureDecision,
          launch: {
            sessionId,
            ...(transition.taskId ? { taskId: transition.taskId.slice(0, 128) } : {}),
            at: transition.at,
          },
        },
      });
      event = {
        kind: transition.kind,
        at: transition.at,
        phase: current.phase,
        message: "The durable continuation task was started",
      };
      break;
    }
    case "closure-recorded":
      Object.assign(next, { closureRecordedAt: transition.at });
      event = {
        kind: transition.kind,
        at: transition.at,
        phase: current.phase,
        message: "Terminal outcome recorded in Pet work memory",
      };
      break;
  }
  next.events = appendEvent(current, event);
  return next;
}

function isStatus(value: unknown): value is PetLongTaskStatus {
  return (
    typeof value === "string" &&
    [
      "queued",
      "running",
      "waiting",
      "paused",
      "interrupted",
      "completed",
      "failed",
      "cancelled",
    ].includes(value)
  );
}

function isPhase(value: unknown): value is PetLongTaskPhase {
  return (
    typeof value === "string" &&
    ["planning", "executing", "waiting-user", "waiting-worker", "finalizing"].includes(value)
  );
}

function isEventKind(value: unknown): value is PetLongTaskEventKind {
  return (
    typeof value === "string" &&
    [
      "created",
      "started",
      "progress",
      "waiting",
      "paused",
      "resumed",
      "retrying",
      "artifact",
      "checkpoint",
      "verification-changed",
      "interrupted",
      "completed",
      "failed",
      "cancelled",
      "closure-decided",
      "continuation-started",
      "closure-recorded",
    ].includes(value)
  );
}

function parseEvent(value: unknown): PetLongTaskEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (
    typeof event.id !== "string" ||
    !event.id ||
    typeof event.sequence !== "number" ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1 ||
    !isEventKind(event.kind) ||
    typeof event.at !== "number" ||
    !Number.isFinite(event.at) ||
    (event.phase !== undefined && !isPhase(event.phase))
  ) {
    return null;
  }
  return {
    id: event.id.slice(0, 256),
    sequence: event.sequence,
    kind: event.kind,
    at: event.at,
    ...(typeof event.message === "string" ? { message: bounded(event.message, 2_000) } : {}),
    ...(isPhase(event.phase) ? { phase: event.phase } : {}),
    ...(typeof event.waitingFor === "string" ? { waitingFor: bounded(event.waitingFor, 500) } : {}),
    ...(typeof event.nextAction === "string" ? { nextAction: bounded(event.nextAction, 500) } : {}),
    ...(Array.isArray(event.artifacts)
      ? { artifacts: normalizeArtifacts(event.artifacts as PetLongTaskArtifact[]) }
      : {}),
  };
}

function parseClosureDecision(value: unknown): PetLongTaskClosureDecision | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.key !== "string" ||
    !record.key.trim() ||
    typeof record.text !== "string" ||
    !record.text.trim() ||
    typeof record.decidedAt !== "number" ||
    !Number.isFinite(record.decidedAt)
  ) {
    return undefined;
  }
  let continuation: PetLongTaskContinuationDecision | undefined;
  if (record.continuation !== undefined) {
    if (
      !record.continuation ||
      typeof record.continuation !== "object" ||
      Array.isArray(record.continuation)
    ) {
      return undefined;
    }
    const candidate = record.continuation as Record<string, unknown>;
    if (
      typeof candidate.clientMessageId !== "string" ||
      !candidate.clientMessageId.trim() ||
      typeof candidate.objective !== "string" ||
      !candidate.objective.trim() ||
      (candidate.workspacePath !== null && typeof candidate.workspacePath !== "string")
    ) {
      return undefined;
    }
    continuation = {
      clientMessageId: candidate.clientMessageId.slice(0, 256),
      objective: candidate.objective.trim().slice(0, 8_000),
      workspacePath:
        typeof candidate.workspacePath === "string"
          ? candidate.workspacePath.slice(0, 4_096)
          : null,
      ...(candidate.executionBackend === "codex"
        ? { executionBackend: "codex" as const }
        : {}),
    };
  }
  let launch: PetLongTaskClosureDecision["launch"];
  if (record.launch !== undefined) {
    if (!record.launch || typeof record.launch !== "object" || Array.isArray(record.launch)) {
      return undefined;
    }
    const candidate = record.launch as Record<string, unknown>;
    if (
      typeof candidate.sessionId !== "string" ||
      !candidate.sessionId.trim() ||
      typeof candidate.at !== "number" ||
      !Number.isFinite(candidate.at) ||
      (candidate.taskId !== undefined && typeof candidate.taskId !== "string")
    ) {
      return undefined;
    }
    launch = {
      sessionId: candidate.sessionId.slice(0, 256),
      ...(typeof candidate.taskId === "string" && candidate.taskId
        ? { taskId: candidate.taskId.slice(0, 128) }
        : {}),
      at: candidate.at,
    };
  }
  return {
    key: record.key.trim().slice(0, 512),
    text: record.text.trim().slice(0, MAX_PET_LONG_TASK_SUMMARY_LENGTH),
    decidedAt: record.decidedAt,
    ...(continuation ? { continuation } : {}),
    ...(launch ? { launch } : {}),
  };
}

/** Defensive parser used by durable hosts. Invalid rows are dropped independently. */
export function parsePetLongTask(value: unknown): PetLongTask | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== PET_LONG_TASK_SCHEMA_VERSION ||
    typeof record.id !== "string" ||
    !record.id ||
    typeof record.originClientMessageId !== "string" ||
    !record.originClientMessageId ||
    typeof record.objective !== "string" ||
    !record.objective ||
    typeof record.sessionId !== "string" ||
    !record.sessionId ||
    !isStatus(record.status) ||
    !isPhase(record.phase) ||
    typeof record.attempt !== "number" ||
    !Number.isSafeInteger(record.attempt) ||
    record.attempt < 1 ||
    typeof record.revision !== "number" ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 1 ||
    typeof record.createdAt !== "number" ||
    typeof record.updatedAt !== "number"
  ) {
    return null;
  }
  const events = Array.isArray(record.events)
    ? record.events
        .map(parseEvent)
        .filter((event): event is PetLongTaskEvent => event !== null)
        .slice(-MAX_PET_LONG_TASK_EVENTS)
    : [];
  const completionTarget = normalizeCompletionTarget(record.completionTarget);
  const continuationDepth =
    typeof record.continuationDepth === "number" &&
    Number.isSafeInteger(record.continuationDepth) &&
    record.continuationDepth > 0
      ? record.continuationDepth
      : 0;
  const closureDecision = parseClosureDecision(record.closureDecision);
  return {
    schemaVersion: PET_LONG_TASK_SCHEMA_VERSION,
    id: record.id.slice(0, 128),
    originClientMessageId: record.originClientMessageId.slice(0, 256),
    objective: record.objective.slice(0, 8_000),
    workspacePath:
      typeof record.workspacePath === "string" ? record.workspacePath.slice(0, 4_096) : null,
    sessionId: record.sessionId.slice(0, 256),
    ...(record.executionBackend === "codex" ? { executionBackend: "codex" as const } : {}),
    // Rows written before verificationMode existed were all launched with a
    // forced Goal. Preserve that meaning while new rows default to turn mode.
    verificationMode: record.verificationMode === "turn" ? "turn" : "goal",
    ...(completionTarget ? { completionTarget } : {}),
    ...(continuationDepth > 0 ? { continuationDepth } : {}),
    status: record.status,
    phase: record.phase,
    attempt: record.attempt,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(typeof record.startedAt === "number" ? { startedAt: record.startedAt } : {}),
    ...(typeof record.completedAt === "number" ? { completedAt: record.completedAt } : {}),
    ...(typeof record.closureRecordedAt === "number"
      ? { closureRecordedAt: record.closureRecordedAt }
      : {}),
    ...(closureDecision ? { closureDecision } : {}),
    ...(typeof record.resultSummary === "string"
      ? { resultSummary: record.resultSummary.slice(0, MAX_PET_LONG_TASK_SUMMARY_LENGTH) }
      : {}),
    ...(typeof record.summary === "string"
      ? { summary: record.summary.slice(0, MAX_PET_LONG_TASK_SUMMARY_LENGTH) }
      : {}),
    ...(typeof record.waitingFor === "string"
      ? { waitingFor: record.waitingFor.slice(0, 500) }
      : {}),
    ...(typeof record.nextAction === "string"
      ? { nextAction: record.nextAction.slice(0, 500) }
      : {}),
    ...(typeof record.lastError === "string"
      ? { lastError: record.lastError.slice(0, 2_000) }
      : {}),
    artifacts: normalizeArtifacts(
      Array.isArray(record.artifacts) ? (record.artifacts as PetLongTaskArtifact[]) : [],
    ),
    events,
  };
}

export interface PetLongTaskContext {
  version: 1;
  active: Array<{
    taskId: string;
    objective: string;
    status: PetLongTaskStatus;
    phase: PetLongTaskPhase;
    sessionId: string;
    workspace?: string;
    attempt: number;
    updatedAt: number;
    summary?: string;
    waitingFor?: string;
    nextAction?: string;
  }>;
  recent: Array<{
    taskId: string;
    objective: string;
    status: "completed" | "failed" | "cancelled";
    updatedAt: number;
    summary?: string;
  }>;
}

/** Bounded task continuity injected into each Mimi manager turn. */
export function buildPetLongTaskContext(tasks: readonly PetLongTask[]): PetLongTaskContext {
  const sorted = [...tasks].sort((left, right) => right.updatedAt - left.updatedAt);
  const active = sorted
    .filter((task) => !TERMINAL.has(task.status))
    .slice(0, 20)
    .map((task) => ({
      taskId: task.id,
      objective: task.objective.slice(0, 800),
      status: task.status,
      phase: task.phase,
      sessionId: task.sessionId,
      ...(task.workspacePath ? { workspace: task.workspacePath.slice(0, 500) } : {}),
      attempt: task.attempt,
      updatedAt: task.updatedAt,
      ...(task.summary ? { summary: task.summary.slice(0, 1_000) } : {}),
      ...(task.waitingFor ? { waitingFor: task.waitingFor.slice(0, 500) } : {}),
      ...(task.nextAction ? { nextAction: task.nextAction.slice(0, 500) } : {}),
    }));
  const recent = sorted
    .filter((task): task is PetLongTask & { status: "completed" | "failed" | "cancelled" } =>
      TERMINAL.has(task.status),
    )
    .slice(0, 10)
    .map((task) => ({
      taskId: task.id,
      objective: task.objective.slice(0, 500),
      status: task.status,
      updatedAt: task.updatedAt,
      ...(task.summary ? { summary: task.summary.slice(0, 800) } : {}),
    }));
  return { version: 1, active, recent };
}

export function petLongTaskResumePrompt(task: PetLongTask): string {
  const durableCheckpoint = task.resultSummary ?? task.summary;
  const checkpoint = durableCheckpoint ? `\nLatest durable checkpoint: ${durableCheckpoint}` : "";
  const next = task.nextAction ? `\nExpected next action: ${task.nextAction}` : "";
  return (
    `Resume the existing long-running task. Preserve prior work in this session, inspect the current state, ` +
    `and continue until the original objective is genuinely verified complete.\n\nOriginal objective: ${task.objective}` +
    `${checkpoint}${next}`
  );
}

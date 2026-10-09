import type { PetLongTaskCompletionTarget } from "./long-task.js";

export type PetFollowUpIntent = "remind" | "resume";
export type PetFollowUpMissedPolicy = "skip" | "fire-once";
export type PetRegisteredFollowUpStatus = "open" | "completed" | "dismissed" | "cancelled";
export type PetFollowUpWakeStatus =
  | "scheduled"
  | "claimed"
  | "notified"
  | "launched"
  | "failed"
  | "unknown";

/** Canonical obligation. A scheduler job is only a rebuildable projection of this record. */
export interface PetRegisteredFollowUp {
  id: string;
  operationKey: string;
  /** Original registration definition, retained so retries cannot undo a later edit. */
  registrationKey: string;
  revision: number;
  title: string;
  text: string;
  wakeAt: number;
  timezone: string;
  missedPolicy: PetFollowUpMissedPolicy;
  catchUpUntil: number;
  intent: PetFollowUpIntent;
  status: PetRegisteredFollowUpStatus;
  createdAt: number;
  updatedAt: number;
  sourceSessionId?: string;
  taskId?: string;
  /** Host-authenticated destination; never accepted from a model's tool arguments. */
  completionTarget?: PetLongTaskCompletionTarget;
  wake: {
    revision: number;
    status: PetFollowUpWakeStatus;
    claimedAt?: number;
    completedAt?: number;
    detail?: string;
    taskId?: string;
  };
}

export interface RegisterPetFollowUpInput {
  operationKey: string;
  title: string;
  text: string;
  wakeAt: number;
  timezone: string;
  missedPolicy?: PetFollowUpMissedPolicy;
  catchUpUntil?: number;
  intent: PetFollowUpIntent;
  sourceSessionId?: string;
  taskId?: string;
  completionTarget?: PetLongTaskCompletionTarget;
}

export interface PetFollowUpWakeOutcome {
  status: "notified" | "launched" | "failed" | "unknown";
  detail?: string;
  taskId?: string;
}

export type PetFollowUpMutationPayload =
  | {
      action: "register";
      title: string;
      text: string;
      wakeAt: number;
      timezone: string;
      missedPolicy?: PetFollowUpMissedPolicy;
      catchUpUntil?: number;
      intent: PetFollowUpIntent;
      sourceSessionId?: string;
      taskId?: string;
    }
  | {
      action: "reschedule";
      followUpId: string;
      expectedRevision: number;
      wakeAt: number;
      timezone: string;
      missedPolicy?: PetFollowUpMissedPolicy;
      catchUpUntil?: number;
    }
  | { action: "cancel"; followUpId: string; expectedRevision: number }
  | { action: "complete" | "dismiss"; followUpId: string; expectedRevision?: number };

export function isFollowUpOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

export function isFollowUpTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 8.64e15;
}

export function isFollowUpRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function isFollowUpTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 128 || value !== value.trim()) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function boundedText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max &&
    !/[\u0000\u007f]/u.test(value)
  );
}

/** Shared defensive validator for tool requests and host-side replayed results. */
export function isPetFollowUpMutationPayload(value: unknown): value is PetFollowUpMutationPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const keys = (allowed: string[]) => Object.keys(payload).every((key) => allowed.includes(key));
  const validMissedPolicy = () =>
    (payload.missedPolicy === undefined ||
      payload.missedPolicy === "skip" ||
      payload.missedPolicy === "fire-once") &&
    (payload.catchUpUntil === undefined ||
      (isFollowUpTimestamp(payload.catchUpUntil) &&
        isFollowUpTimestamp(payload.wakeAt) &&
        payload.catchUpUntil >= payload.wakeAt));
  if (payload.action === "register") {
    return (
      keys([
        "action",
        "title",
        "text",
        "wakeAt",
        "timezone",
        "intent",
        "sourceSessionId",
        "taskId",
        "missedPolicy",
        "catchUpUntil",
      ]) &&
      boundedText(payload.title, 512) &&
      boundedText(payload.text, 8_000) &&
      isFollowUpTimestamp(payload.wakeAt) &&
      isFollowUpTimezone(payload.timezone) &&
      validMissedPolicy() &&
      (payload.intent === "remind" || payload.intent === "resume") &&
      (payload.sourceSessionId === undefined || isFollowUpOpaqueId(payload.sourceSessionId)) &&
      (payload.taskId === undefined || isFollowUpOpaqueId(payload.taskId)) &&
      (payload.intent !== "resume" || isFollowUpOpaqueId(payload.sourceSessionId)) &&
      (payload.intent !== "remind" ||
        (payload.sourceSessionId === undefined && payload.taskId === undefined)) &&
      (payload.taskId === undefined || isFollowUpOpaqueId(payload.sourceSessionId))
    );
  }
  if (!isFollowUpOpaqueId(payload.followUpId)) return false;
  if (payload.action === "reschedule") {
    return (
      keys([
        "action",
        "followUpId",
        "expectedRevision",
        "wakeAt",
        "timezone",
        "missedPolicy",
        "catchUpUntil",
      ]) &&
      isFollowUpRevision(payload.expectedRevision) &&
      isFollowUpTimestamp(payload.wakeAt) &&
      isFollowUpTimezone(payload.timezone) &&
      validMissedPolicy()
    );
  }
  if (payload.action === "cancel") {
    return (
      keys(["action", "followUpId", "expectedRevision"]) &&
      isFollowUpRevision(payload.expectedRevision)
    );
  }
  return (
    (payload.action === "complete" || payload.action === "dismiss") &&
    keys(["action", "followUpId", "expectedRevision"]) &&
    (payload.expectedRevision === undefined || isFollowUpRevision(payload.expectedRevision))
  );
}

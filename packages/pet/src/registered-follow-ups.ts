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

/** A recurrence is a 5-field cron expression; this bounds its length. */
export const FOLLOW_UP_RECURRENCE_MAX_LENGTH = 64;

/**
 * One due occurrence of a follow-up, handed to Mimi's host-woken turn. The
 * follow-up itself is a schedule rule in the Desktop rule table: `id` is the
 * rule id, `revision` its version and `occurrence` the scheduled instant.
 */
export interface PetFollowUpWake {
  id: string;
  revision: number;
  occurrence: number;
  title: string;
  text: string;
  intent: PetFollowUpIntent;
  sourceSessionId?: string;
  taskId?: string;
  /** Host-authenticated destination; never accepted from a model's tool arguments. */
  completionTarget?: PetLongTaskCompletionTarget;
}

/** When a follow-up fires: exactly one of `wakeAt` (once) and `recurrence` (cron). */
interface PetFollowUpTiming {
  wakeAt?: number;
  recurrence?: string;
  timezone: string;
  missedPolicy?: PetFollowUpMissedPolicy;
  /** Only with `wakeAt`: last instant a missed wake may still catch up. */
  catchUpUntil?: number;
}

export type PetFollowUpMutationPayload =
  | ({
      action: "register";
      title: string;
      text: string;
      intent: PetFollowUpIntent;
      sourceSessionId?: string;
      taskId?: string;
    } & PetFollowUpTiming)
  | ({ action: "reschedule"; followUpId: string; expectedRevision: number } & PetFollowUpTiming)
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

const CRON_FIELD = /^[\d*/,-]+$/u;

/**
 * Why a recurrence is not acceptable, or undefined when it is. A pure shape
 * check: 5 cron fields, and a single minute value, so it fires at most once an
 * hour. The host additionally parses it with the scheduler's cron parser.
 * Turning the owner's words into cron is the model's job, not this code's.
 */
export function followUpRecurrenceProblem(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > FOLLOW_UP_RECURRENCE_MAX_LENGTH ||
    value !== value.trim()
  )
    return "recurrence must be a 5-field cron expression";
  const fields = value.split(/\s+/u);
  if (fields.length !== 5 || !fields.every((field) => CRON_FIELD.test(field)))
    return "recurrence must be a 5-field cron expression: minute hour day-of-month month day-of-week";
  const minute = fields[0]!;
  if (!/^\d{1,2}$/u.test(minute) || Number(minute) > 59)
    return "recurrence fires at most once an hour: its minute field must be one number from 0 to 59";
  return undefined;
}

export function isFollowUpRecurrence(value: unknown): value is string {
  return followUpRecurrenceProblem(value) === undefined;
}

function boundedText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max &&
    !/[\u0000\u007f]/u.test(value)
  );
}

function validTiming(payload: Record<string, unknown>): boolean {
  const once = payload.wakeAt !== undefined;
  if (once === (payload.recurrence !== undefined)) return false;
  if (once ? !isFollowUpTimestamp(payload.wakeAt) : !isFollowUpRecurrence(payload.recurrence))
    return false;
  if (!isFollowUpTimezone(payload.timezone)) return false;
  if (
    payload.missedPolicy !== undefined &&
    payload.missedPolicy !== "skip" &&
    payload.missedPolicy !== "fire-once"
  )
    return false;
  if (payload.catchUpUntil === undefined) return true;
  return (
    once &&
    isFollowUpTimestamp(payload.catchUpUntil) &&
    payload.catchUpUntil >= (payload.wakeAt as number)
  );
}

const TIMING_KEYS = ["wakeAt", "recurrence", "timezone", "missedPolicy", "catchUpUntil"];

/** Shared defensive validator for tool requests and host-side replayed results. */
export function isPetFollowUpMutationPayload(value: unknown): value is PetFollowUpMutationPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const keys = (allowed: string[]) => Object.keys(payload).every((key) => allowed.includes(key));
  if (payload.action === "register") {
    return (
      keys(["action", "title", "text", "intent", "sourceSessionId", "taskId", ...TIMING_KEYS]) &&
      boundedText(payload.title, 512) &&
      boundedText(payload.text, 8_000) &&
      validTiming(payload) &&
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
      keys(["action", "followUpId", "expectedRevision", ...TIMING_KEYS]) &&
      isFollowUpRevision(payload.expectedRevision) &&
      validTiming(payload)
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

import { nextCronTime, parseCronExpression } from "@cjhyy/code-shell-core/internal";
import {
  followUpRecurrenceProblem,
  isFollowUpOpaqueId,
  isFollowUpScheduleLabel,
  isFollowUpTimestamp,
  isFollowUpTimezone,
  type PetFollowUpMissedPolicy,
  type PetFollowUpWakeStatus,
} from "@cjhyy/code-shell-pet";

/**
 * Time-triggered rules (design §4.1 `when.kind: "schedule"`): the shape the
 * rule store validates and the occurrence arithmetic the rule scheduler uses.
 * Pure: no store, no timers.
 *
 * A schedule fires once (`at`) or on a 5-field cron (`cron`), never more
 * often than hourly. `wake` tracks the CURRENT occurrence only: a repeating
 * rule moves to its next occurrence once the current one is settled, so a
 * sleep never replays more than one missed occurrence.
 */

export interface ScheduleWhen {
  kind: "schedule";
  /** One-shot instant (epoch ms). Exactly one of `at` and `cron`. */
  at?: number;
  /** Recurring 5-field cron expression, evaluated in `timezone`. */
  cron?: string;
  /**
   * With `cron` (required): the schedule in the owner's words, written by
   * Mimi ("工作日 09:00"). Untrusted display text, never parsed.
   */
  label?: string;
  timezone: string;
  missedPolicy: PetFollowUpMissedPolicy;
  /** One-shot only: last instant a missed occurrence may still catch up (>= at). */
  catchUpUntil?: number;
}

/** What an owner-asked follow-up does when it fires. */
export type FollowUpThen =
  /** Tell the owner (or the IM conversation that asked) the text: Notice `followup.due`. */
  | { mode: "remind"; title: string; text: string }
  /** Wake Mimi to continue exactly `sourceSessionId`, then tell the owner what happened. */
  | { mode: "run-mimi"; title: string; text: string; sourceSessionId: string; taskId?: string };

/** What one of Mimi's own (system) schedule rules does (design §10.1, §10.2). */
export type SystemScheduleThen =
  /** Collect the facts since the last brief, have them written up, send `brief.<brief>`. */
  | { mode: "compose"; brief: "morning" | "evening" }
  /** Heartbeat: look for new facts; only if there are any, ask a model whether to say something. */
  | { mode: "judge"; kind: "heartbeat" };

/** What a schedule rule does when it fires. */
export type ScheduleThen = FollowUpThen | SystemScheduleThen;

export function isSystemScheduleThen(then: ScheduleThen): then is SystemScheduleThen {
  return then.mode === "compose" || then.mode === "judge";
}

export type RuleWakeStatus = PetFollowUpWakeStatus;

/** Durable state of the current occurrence; the claim precedes every effect. */
export interface RuleWake {
  /** The occurrence's scheduled instant (before any stagger). */
  occurrence: number;
  /**
   * Delay (ms, whole minutes up to 5) when other schedule rules already had
   * an occurrence in the same minute; fixed when the occurrence is assigned,
   * so it does not shift as its neighbours fire. Absent = 0.
   */
  stagger?: number;
  status: RuleWakeStatus;
  claimedAt?: number;
  completedAt?: number;
  /** What happened (last occurrence for a repeating rule that moved on). */
  detail?: string;
  /** Long task a `run-mimi` occurrence launched. */
  taskId?: string;
  /**
   * A repeating rule's last settled occurrence, kept when it moves on to the
   * next one (and through that one's claim), so the rule list can say when it
   * last fired and how. Display only: nothing schedules from it.
   */
  previous?: RuleWakePrevious;
}

export interface RuleWakePrevious {
  occurrence: number;
  status: RuleWakeOutcome["status"];
  completedAt: number;
}

export type RuleWakeOutcome = {
  status: "notified" | "launched" | "failed" | "unknown";
  detail?: string;
  taskId?: string;
};

export const SCHEDULE_TITLE_MAX = 512;
export const SCHEDULE_TEXT_MAX = 8_000;
export const WAKE_DETAIL_MAX = 2_000;
/** Default catch-up window of a one-shot, and the cap of a repeating rule's. */
export const DEFAULT_CATCH_UP_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const MINUTE_MS = 60_000;
/** Same-minute schedules are spread over 0–5 minutes, one minute apart. */
const STAGGER_SLOTS = 6;
/** A repeating occurrence's catch-up ends this long before the next one is due. */
const CATCH_UP_MARGIN_MS = 60_000;
/** Longest each month can be (February: 29, in leap years). */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max &&
    !/[\u0000\u007f]/u.test(value)
  );
}

/**
 * Why `cron` cannot drive a schedule, or undefined. Shape (5 fields, single
 * minute value: at most hourly) is the shared tool check; the scheduler's own
 * parser then has the last word. Whether it ever fires is found by the first
 * occurrence search (`firstOccurrence` → null), done once at registration.
 */
export function cronProblem(cron: unknown, options: CronOptions = {}): string | undefined {
  const shape = followUpRecurrenceProblem(options.halfHourly ? hourlyForm(cron) : cron);
  if (shape) return shape;
  let parsed: ReturnType<typeof parseCronExpression>;
  try {
    parsed = parseCronExpression(cron as string);
  } catch (error) {
    return `recurrence is not a valid cron expression: ${error instanceof Error ? error.message : String(error)}`;
  }
  // Only day-of-month restricts the date (with both, day-of-week can match):
  // a day that exists in none of the months (30 February) never comes.
  if (parsed.domRestricted && !parsed.dowRestricted) {
    const longest = Math.max(...[...parsed.months].map((month) => MONTH_DAYS[month - 1]!));
    if (Math.min(...parsed.daysOfMonth) > longest)
      return "recurrence never fires: that day of the month does not exist in the chosen months";
  }
  return undefined;
}

/**
 * The one exemption from "at most hourly": Mimi's heartbeat (a system rule
 * whose cron the host writes, never a model) may fire twice an hour, at
 * minutes exactly 30 apart ("5,35 9-21 * * *"). Nothing else may.
 */
export interface CronOptions {
  halfHourly?: boolean;
}

const HALF_HOURLY_MINUTES = /^(\d{1,2}),(\d{1,2})(?=\s)/u;

/** A half-hourly cron as its hourly twin (first minute only); anything else unchanged. */
function hourlyForm(cron: unknown): unknown {
  if (typeof cron !== "string") return cron;
  const match = HALF_HOURLY_MINUTES.exec(cron);
  if (!match || Number(match[1]) >= 30 || Number(match[2]) !== Number(match[1]) + 30) return cron;
  return cron.replace(HALF_HOURLY_MINUTES, match[1]!);
}

/** Structural cron check only (no date search): cheap enough for every row load. */
function isCronShape(value: unknown, options?: CronOptions): value is string {
  return cronProblem(value, options) === undefined;
}

export function parseScheduleWhen(
  value: unknown,
  options: CronOptions = {},
): ScheduleWhen | undefined {
  if (!isRecord(value) || value.kind !== "schedule") return undefined;
  if (
    !hasOnlyKeys(value, ["kind", "at", "cron", "label", "timezone", "missedPolicy", "catchUpUntil"])
  )
    return undefined;
  const once = value.at !== undefined;
  if (once === (value.cron !== undefined)) return undefined;
  if (once ? !isFollowUpTimestamp(value.at) : !isCronShape(value.cron, options)) return undefined;
  if (once ? value.label !== undefined : !isFollowUpScheduleLabel(value.label)) return undefined;
  if (!isFollowUpTimezone(value.timezone)) return undefined;
  if (value.missedPolicy !== "skip" && value.missedPolicy !== "fire-once") return undefined;
  if (
    value.catchUpUntil !== undefined &&
    (!once || !isFollowUpTimestamp(value.catchUpUntil) || value.catchUpUntil < (value.at as number))
  )
    return undefined;
  return value as unknown as ScheduleWhen;
}

export function parseScheduleThen(value: unknown): ScheduleThen | undefined {
  if (!isRecord(value)) return undefined;
  if (value.mode === "compose")
    return hasOnlyKeys(value, ["mode", "brief"]) &&
      (value.brief === "morning" || value.brief === "evening")
      ? (value as ScheduleThen)
      : undefined;
  if (value.mode === "judge")
    return hasOnlyKeys(value, ["mode", "kind"]) && value.kind === "heartbeat"
      ? (value as ScheduleThen)
      : undefined;
  if (!isText(value.title, SCHEDULE_TITLE_MAX) || !isText(value.text, SCHEDULE_TEXT_MAX))
    return undefined;
  if (value.mode === "remind")
    return hasOnlyKeys(value, ["mode", "title", "text"]) ? (value as ScheduleThen) : undefined;
  if (value.mode !== "run-mimi") return undefined;
  if (
    !hasOnlyKeys(value, ["mode", "title", "text", "sourceSessionId", "taskId"]) ||
    !isFollowUpOpaqueId(value.sourceSessionId) ||
    (value.taskId !== undefined && !isFollowUpOpaqueId(value.taskId))
  )
    return undefined;
  return value as ScheduleThen;
}

const WAKE_STATUSES: readonly RuleWakeStatus[] = [
  "scheduled",
  "claimed",
  "notified",
  "launched",
  "failed",
  "unknown",
];

const SETTLED_STATUSES: readonly RuleWakeStatus[] = ["notified", "launched", "failed", "unknown"];

function isWakePrevious(value: unknown): value is RuleWakePrevious {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["occurrence", "status", "completedAt"]) &&
    isFollowUpTimestamp(value.occurrence) &&
    (SETTLED_STATUSES as readonly unknown[]).includes(value.status) &&
    isFollowUpTimestamp(value.completedAt)
  );
}

export function parseRuleWake(value: unknown): RuleWake | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !hasOnlyKeys(value, [
      "occurrence",
      "stagger",
      "status",
      "claimedAt",
      "completedAt",
      "detail",
      "taskId",
      "previous",
    ]) ||
    !isFollowUpTimestamp(value.occurrence) ||
    (value.previous !== undefined && !isWakePrevious(value.previous)) ||
    (value.stagger !== undefined &&
      (typeof value.stagger !== "number" ||
        !Number.isSafeInteger(value.stagger) ||
        value.stagger <= 0 ||
        value.stagger % MINUTE_MS !== 0 ||
        value.stagger >= STAGGER_SLOTS * MINUTE_MS)) ||
    !(WAKE_STATUSES as readonly unknown[]).includes(value.status) ||
    (value.claimedAt !== undefined && !isFollowUpTimestamp(value.claimedAt)) ||
    (value.completedAt !== undefined && !isFollowUpTimestamp(value.completedAt)) ||
    (value.detail !== undefined &&
      (typeof value.detail !== "string" ||
        value.detail.length > WAKE_DETAIL_MAX ||
        value.detail.includes("\0"))) ||
    (value.taskId !== undefined && !isFollowUpOpaqueId(value.taskId))
  )
    return undefined;
  // A scheduled occurrence has not started (its `detail` may describe the
  // previous one); a claimed one has not finished; a settled one has both.
  const started = value.status !== "scheduled";
  const finished = started && value.status !== "claimed";
  if ((value.claimedAt !== undefined) !== started) return undefined;
  if ((value.completedAt !== undefined) !== finished) return undefined;
  return value as unknown as RuleWake;
}

/** The first occurrence after `now` (one-shot: its instant, past or not). */
export function firstOccurrence(when: ScheduleWhen, now: number): number | null {
  if (when.at !== undefined) return when.at;
  return nextCronTime(parseCronExpression(when.cron!), when.timezone, now);
}

/** The occurrence after `after` for a repeating rule; null for a one-shot. */
export function nextOccurrence(when: ScheduleWhen, after: number): number | null {
  if (when.cron === undefined) return null;
  return nextCronTime(parseCronExpression(when.cron), when.timezone, after);
}

/**
 * Last instant a missed occurrence may still fire (`fire-once`). A one-shot
 * uses its own `catchUpUntil` (default: a day). A repeating occurrence may
 * catch up until shortly before the next one could be due, at most a day:
 * the cron fires at a single minute of each matching hour, so the closest
 * two occurrences can be is the smallest gap between its matching hours.
 */
export function occurrenceDeadline(when: ScheduleWhen, occurrence: number): number {
  if (when.at !== undefined) return when.catchUpUntil ?? when.at + DEFAULT_CATCH_UP_MS;
  const parsed = parseCronExpression(when.cron!);
  // Half-hourly (the heartbeat): the next occurrence can be 30 minutes away.
  if (parsed.minutes.size > 1) return occurrence + HOUR_MS / 2 - CATCH_UP_MARGIN_MS;
  const hours = [...parsed.hours].sort((a, b) => a - b);
  let gap = 24;
  for (let index = 0; index < hours.length; index += 1) {
    const next = hours[(index + 1) % hours.length]! + (index + 1 === hours.length ? 24 : 0);
    if (hours.length > 1) gap = Math.min(gap, next - hours[index]!);
  }
  return occurrence + Math.min(DEFAULT_CATCH_UP_MS, gap * HOUR_MS) - CATCH_UP_MARGIN_MS;
}

/** When an occurrence is actually due: its instant plus its stagger. */
export function dueAt(wake: Pick<RuleWake, "occurrence" | "stagger">): number {
  return wake.occurrence + (wake.stagger ?? 0);
}

/**
 * The stagger for a new occurrence, given the occurrences other schedule
 * rules already hold: one minute per earlier same-minute neighbour, wrapping
 * after five. Deterministic: it depends only on what is stored.
 */
export function staggerFor(occurrence: number, others: readonly number[]): number {
  const minute = Math.floor(occurrence / MINUTE_MS);
  const neighbours = others.filter((other) => Math.floor(other / MINUTE_MS) === minute).length;
  return (neighbours % STAGGER_SLOTS) * MINUTE_MS;
}

/**
 * The next `count` occurrences from `occurrence` on (inclusive), for the
 * owner-facing confirmation. A one-shot has just its own.
 */
export function upcomingOccurrences(when: ScheduleWhen, occurrence: number, count = 2): number[] {
  const result = [occurrence];
  while (result.length < count) {
    const next = nextOccurrence(when, result[result.length - 1]!);
    if (next === null) break;
    result.push(next);
  }
  return result;
}

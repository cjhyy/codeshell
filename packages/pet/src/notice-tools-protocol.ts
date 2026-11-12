/**
 * Wire contract of Mimi's own notice tools (design §4.7): what she may read
 * about the notices and triggers the host keeps for the owner, and the
 * structured changes she may ask for. Shared by the worker-side tools and the
 * Desktop host, which re-validates every payload and decides authority from
 * the authenticated turn, never from these fields.
 *
 * Reads are synchronous host loopbacks (`requestHostAction`):
 *   - {@link PET_NOTICES_QUERY_ACTION} with {@link PetNoticesQuery};
 *   - {@link PET_TRIGGERS_QUERY_ACTION} with `{ includeEnded?: boolean }`;
 *   - {@link PET_NOTIFICATION_SETTINGS_QUERY_ACTION} with `{}`.
 * Changes are deferred host actions (`noticeTriggerMutation`,
 * `notificationSettingsMutation`) the host runs after the turn.
 */

export const PET_NOTICES_QUERY_ACTION = "pet.notices.query";
export const PET_TRIGGERS_QUERY_ACTION = "pet.triggers.query";
export const PET_NOTIFICATION_SETTINGS_QUERY_ACTION = "pet.notifications.read";

/** Notice kinds the ledger records (design §8.2). */
export const PET_NOTICE_KINDS = [
  "brief.morning",
  "brief.evening",
  "heartbeat",
  "session.done",
  "session.failed",
  "session.blocked",
  "session.report",
  "followup.due",
  "digest",
] as const;
export type PetNoticeKind = (typeof PET_NOTICE_KINDS)[number];

export const PET_NOTICES_DEFAULT_LIMIT = 10;
export const PET_NOTICES_MAX_LIMIT = 30;
/** Each notice's text in a Notices result is cut to this many characters. */
export const PET_NOTICE_TEXT_MAX = 600;
/** A snooze holds non-decision notices for at most a day. */
export const PET_SNOOZE_MAX_MINUTES = 24 * 60;

export interface PetNoticesQuery {
  kinds?: PetNoticeKind[];
  sessionId?: string;
  /** Epoch ms, inclusive. */
  since?: number;
  /** Epoch ms, inclusive. */
  until?: number;
  limit: number;
}

export const PET_TRIGGER_ACTIONS = [
  "pause",
  "resume",
  "cancel",
  "enable",
  "disable",
  "set_time",
  "set_active_hours",
] as const;
export type PetTriggerAction = (typeof PET_TRIGGER_ACTIONS)[number];

export type PetTriggerMutation =
  | {
      ruleId: string;
      action: "pause" | "resume" | "cancel" | "enable" | "disable";
      expectedVersion?: number;
    }
  | { ruleId: string; action: "set_time"; time: string; expectedVersion?: number }
  | {
      ruleId: string;
      action: "set_active_hours";
      start: string;
      end: string;
      expectedVersion?: number;
    };

/** Only the fields the owner asked to change (each written on its own). */
export interface PetNotificationSettingsPatch {
  quietHours?: { start?: string; end?: string; enabled?: boolean };
  maxPerHour?: number;
  maxP0PerHour?: number;
  mergeWindowSec?: number;
  presenceIdleSec?: number;
  delegatedFromDesktop?: "auto" | "desktop";
  /** Replaces the slot list; empty clears it. */
  digestSlots?: string[];
  briefs?: Partial<Record<"morning" | "evening", { enabled?: boolean; time?: string }>>;
  heartbeat?: { enabled?: boolean; activeHours?: { start: string; end: string } };
}

/** `minutes` from now, or until an instant (epoch ms); null cancels a snooze. */
export type PetSnoozeRequest = { minutes: number } | { until: number } | null;

export interface PetNotificationSettingsMutation {
  patch?: PetNotificationSettingsPatch;
  snooze?: PetSnoozeRequest;
}

/** Bounds of `settings.pet.notifications` (the settings schema enforces the same). */
export const PET_NOTIFICATION_RANGES = {
  maxPerHour: { min: 1, max: 60 },
  maxP0PerHour: { min: 1, max: 120 },
  mergeWindowSec: { min: 0, max: 3_600 },
  presenceIdleSec: { min: 30, max: 1_800 },
} as const;
export const PET_DIGEST_SLOTS_MAX = 6;

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/u;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).every((key) => keys.includes(key));
}

export function isClockTime(value: unknown): value is string {
  return typeof value === "string" && HH_MM.test(value);
}

function isEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 8.64e15;
}

function inRange(value: unknown, range: { min: number; max: number }): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= range.min && (value as number) <= range.max
  );
}

export function isPetNoticeKind(value: unknown): value is PetNoticeKind {
  return (PET_NOTICE_KINDS as readonly unknown[]).includes(value);
}

/** The Notices query as the host accepts it; undefined when malformed. */
export function parsePetNoticesQuery(value: unknown): PetNoticesQuery | undefined {
  if (!isRecord(value) || !onlyKeys(value, ["kinds", "sessionId", "since", "until", "limit"]))
    return undefined;
  const { kinds, sessionId, since, until, limit } = value;
  if (
    kinds !== undefined &&
    (!Array.isArray(kinds) ||
      kinds.length === 0 ||
      kinds.length > PET_NOTICE_KINDS.length ||
      !kinds.every(isPetNoticeKind) ||
      new Set(kinds).size !== kinds.length)
  )
    return undefined;
  if (sessionId !== undefined && (typeof sessionId !== "string" || !OPAQUE_ID.test(sessionId)))
    return undefined;
  if (since !== undefined && !isEpoch(since)) return undefined;
  if (until !== undefined && !isEpoch(until)) return undefined;
  if (since !== undefined && until !== undefined && since > until) return undefined;
  if (!inRange(limit, { min: 1, max: PET_NOTICES_MAX_LIMIT })) return undefined;
  return {
    ...(kinds ? { kinds: [...(kinds as PetNoticeKind[])] } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    limit,
  };
}

export function isPetTriggerMutation(value: unknown): value is PetTriggerMutation {
  if (!isRecord(value)) return false;
  const { ruleId, action, expectedVersion } = value;
  if (typeof ruleId !== "string" || !OPAQUE_ID.test(ruleId)) return false;
  if (
    expectedVersion !== undefined &&
    (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 0)
  )
    return false;
  const base = ["ruleId", "action", "expectedVersion"];
  if (action === "set_time") return onlyKeys(value, [...base, "time"]) && isClockTime(value.time);
  if (action === "set_active_hours")
    return (
      onlyKeys(value, [...base, "start", "end"]) &&
      isClockTime(value.start) &&
      isClockTime(value.end) &&
      value.start !== value.end
    );
  return (
    onlyKeys(value, base) &&
    (PET_TRIGGER_ACTIONS as readonly unknown[]).includes(action) &&
    typeof action === "string"
  );
}

/** At most this many trigger changes in one ManageTrigger call. */
export const PET_TRIGGER_CHANGES_MAX = 5;

/** One change, or several applied in order (each checked on its own). */
export type PetTriggerMutationRequest = PetTriggerMutation | { changes: PetTriggerMutation[] };

export function isPetTriggerMutationRequest(value: unknown): value is PetTriggerMutationRequest {
  if (!isRecord(value) || !("changes" in value)) return isPetTriggerMutation(value);
  const changes = value.changes;
  return (
    Object.keys(value).length === 1 &&
    Array.isArray(changes) &&
    changes.length >= 1 &&
    changes.length <= PET_TRIGGER_CHANGES_MAX &&
    changes.every(isPetTriggerMutation)
  );
}

/** The changes of a request, in order. */
export function petTriggerChanges(request: PetTriggerMutationRequest): PetTriggerMutation[] {
  return "changes" in request ? [...request.changes] : [request];
}

function isBriefSlotPatch(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length > 0 &&
    onlyKeys(value, ["enabled", "time"]) &&
    (value.enabled === undefined || typeof value.enabled === "boolean") &&
    (value.time === undefined || isClockTime(value.time))
  );
}

function isSettingsPatch(value: unknown): value is PetNotificationSettingsPatch {
  if (!isRecord(value) || Object.keys(value).length === 0) return false;
  const keys = [
    "quietHours",
    "maxPerHour",
    "maxP0PerHour",
    "mergeWindowSec",
    "presenceIdleSec",
    "delegatedFromDesktop",
    "digestSlots",
    "briefs",
    "heartbeat",
  ];
  if (!onlyKeys(value, keys)) return false;
  const { quietHours, briefs, heartbeat, digestSlots, delegatedFromDesktop } = value;
  if (
    quietHours !== undefined &&
    (!isRecord(quietHours) ||
      Object.keys(quietHours).length === 0 ||
      !onlyKeys(quietHours, ["start", "end", "enabled"]) ||
      (quietHours.start !== undefined && !isClockTime(quietHours.start)) ||
      (quietHours.end !== undefined && !isClockTime(quietHours.end)) ||
      (quietHours.enabled !== undefined && typeof quietHours.enabled !== "boolean"))
  )
    return false;
  for (const field of Object.keys(
    PET_NOTIFICATION_RANGES,
  ) as (keyof typeof PET_NOTIFICATION_RANGES)[])
    if (value[field] !== undefined && !inRange(value[field], PET_NOTIFICATION_RANGES[field]))
      return false;
  if (
    delegatedFromDesktop !== undefined &&
    delegatedFromDesktop !== "auto" &&
    delegatedFromDesktop !== "desktop"
  )
    return false;
  if (
    digestSlots !== undefined &&
    (!Array.isArray(digestSlots) ||
      digestSlots.length > PET_DIGEST_SLOTS_MAX ||
      !digestSlots.every(isClockTime) ||
      new Set(digestSlots).size !== digestSlots.length)
  )
    return false;
  if (
    briefs !== undefined &&
    (!isRecord(briefs) ||
      Object.keys(briefs).length === 0 ||
      !onlyKeys(briefs, ["morning", "evening"]) ||
      !Object.values(briefs).every(isBriefSlotPatch))
  )
    return false;
  if (heartbeat !== undefined) {
    if (
      !isRecord(heartbeat) ||
      Object.keys(heartbeat).length === 0 ||
      !onlyKeys(heartbeat, ["enabled", "activeHours"]) ||
      (heartbeat.enabled !== undefined && typeof heartbeat.enabled !== "boolean")
    )
      return false;
    const hours = heartbeat.activeHours;
    if (
      hours !== undefined &&
      (!isRecord(hours) ||
        !onlyKeys(hours, ["start", "end"]) ||
        !isClockTime(hours.start) ||
        !isClockTime(hours.end) ||
        hours.start === hours.end)
    )
      return false;
  }
  return true;
}

function isSnoozeRequest(value: unknown): value is PetSnoozeRequest {
  if (value === null) return true;
  if (!isRecord(value) || Object.keys(value).length !== 1) return false;
  if ("minutes" in value) return inRange(value.minutes, { min: 1, max: PET_SNOOZE_MAX_MINUTES });
  return "until" in value && isEpoch(value.until);
}

export function isPetNotificationSettingsMutation(
  value: unknown,
): value is PetNotificationSettingsMutation {
  if (!isRecord(value) || !onlyKeys(value, ["patch", "snooze"])) return false;
  if (value.patch === undefined && !("snooze" in value)) return false;
  if (value.patch !== undefined && !isSettingsPatch(value.patch)) return false;
  return !("snooze" in value) || isSnoozeRequest(value.snooze);
}

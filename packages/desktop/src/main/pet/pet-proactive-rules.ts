import { localMinuteOfDay } from "./pet-notice-policy.js";
import type { PetNotificationSettings } from "./pet-notice-settings.js";
import type { PetRuleStore, SystemScheduleInput, SystemScheduleRuleId } from "./pet-rule-store.js";
import type { ScheduleWhen } from "./pet-schedule-rule.js";

/**
 * Mimi's proactive behaviour as rules (design §10): the morning brief, the
 * evening wrap-up and the heartbeat are system `schedule` rules in the rule
 * table, fired by the same scheduler as the owner's follow-ups. This module
 * turns the owner's settings into those rules' timing; nothing here fires.
 */

const MINUTES_PER_DAY = 24 * 60;
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/u;
/** The heartbeat looks every 30 minutes (design §10.2). */
export const HEARTBEAT_INTERVAL_MIN = 30;

export type ClockWindow = { start: string; end: string };

function clock(value: string): number {
  const match = HH_MM.exec(value);
  if (!match) throw new Error(`invalid local time: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** The host's IANA timezone (the one quiet hours and the hourly caps use). */
export function hostTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** "HH:MM" every day. */
export function dailyCron(time: string): string {
  const minute = clock(time);
  return `${minute % 60} ${Math.floor(minute / 60)} * * *`;
}

/**
 * Whether a local minute of the day lies in [start, end) (may cross
 * midnight). start === end is the whole day.
 */
export function inWindowMinute(window: ClockWindow, minute: number): boolean {
  const start = clock(window.start);
  const end = clock(window.end);
  if (start === end) return true;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function inClockWindow(window: ClockWindow, now: number, offsetMin: number): boolean {
  return inWindowMinute(window, localMinuteOfDay(now, offsetMin));
}

function hourField(hours: readonly number[]): string {
  const ranges: string[] = [];
  let index = 0;
  while (index < hours.length) {
    let last = index;
    while (last + 1 < hours.length && hours[last + 1] === hours[last]! + 1) last += 1;
    ranges.push(last === index ? `${hours[index]}` : `${hours[index]}-${hours[last]}`);
    index = last + 1;
  }
  return ranges.join(",");
}

/**
 * Every 30 minutes from the window's start, over the hours the window
 * touches: "0,30 9-21 * * *" for 09:00–22:00. A slot in an edge hour may
 * fall outside the window (09:00–21:20 also matches 21:30); the heartbeat
 * checks the window again when it fires.
 */
export function heartbeatCron(window: ClockWindow): string {
  const start = clock(window.start);
  const first = start % HEARTBEAT_INTERVAL_MIN;
  const hours = new Set<number>();
  for (let slot = 0; slot < MINUTES_PER_DAY / HEARTBEAT_INTERVAL_MIN; slot += 1) {
    const minute = (start + slot * HEARTBEAT_INTERVAL_MIN) % MINUTES_PER_DAY;
    if (inWindowMinute(window, minute)) hours.add(Math.floor(minute / 60));
  }
  const sorted = [...hours].sort((a, b) => a - b);
  return `${first},${first + HEARTBEAT_INTERVAL_MIN} ${hourField(sorted)} * * *`;
}

/** What the settings ask of each system schedule rule (the recheck is armed by the heartbeat). */
export function systemScheduleInputs(
  settings: Pick<PetNotificationSettings, "briefs" | "heartbeat">,
  timezone: string,
): Array<[SystemScheduleRuleId, SystemScheduleInput]> {
  const brief = (time: string, enabled: boolean, name: string): SystemScheduleInput => ({
    when: {
      kind: "schedule",
      cron: dailyCron(time),
      label: `${name} 每天 ${time}`,
      timezone,
      // Slept through: caught up once on wake, but only the same day (the brief checks).
      missedPolicy: "fire-once",
    },
    state: enabled ? "active" : "paused",
  });
  const { activeHours } = settings.heartbeat;
  const heartbeat: ScheduleWhen = {
    kind: "schedule",
    cron: heartbeatCron(activeHours),
    label: `心跳 ${activeHours.start}–${activeHours.end} 每 30 分钟`,
    timezone,
    // A heartbeat that was missed is not owed: the next one looks again.
    missedPolicy: "skip",
  };
  return [
    [
      "system-brief-morning",
      brief(settings.briefs.morning.time, settings.briefs.morning.enabled, "早报"),
    ],
    [
      "system-brief-evening",
      brief(settings.briefs.evening.time, settings.briefs.evening.enabled, "收工小结"),
    ],
    [
      "system-heartbeat",
      { when: heartbeat, state: settings.heartbeat.enabled ? "active" : "paused" },
    ],
  ];
}

/**
 * Bring the system schedule rules in line with the settings. Each rule is
 * written on its own: one that fails is logged and the others still apply.
 * Switching the heartbeat off also pauses a pending recheck.
 */
export async function syncSystemSchedules(
  rules: Pick<PetRuleStore, "setSystemSchedule" | "get" | "update">,
  settings: Pick<PetNotificationSettings, "briefs" | "heartbeat">,
  timezone: string,
  log: (event: string, data: Record<string, unknown>) => void,
): Promise<void> {
  for (const [id, input] of systemScheduleInputs(settings, timezone)) {
    try {
      await rules.setSystemSchedule(id, input);
    } catch (error) {
      log("pet.proactive.rule_sync_failed", { id, error: String(error) });
    }
  }
  const recheck = rules.get("system-heartbeat-recheck");
  if (!settings.heartbeat.enabled && recheck?.state === "active") {
    try {
      await rules.update(recheck.id, recheck.version, { state: "paused" });
    } catch (error) {
      log("pet.proactive.rule_sync_failed", { id: recheck.id, error: String(error) });
    }
  }
}

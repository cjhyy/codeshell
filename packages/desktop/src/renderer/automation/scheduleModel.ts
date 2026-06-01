/**
 * Two-way conversion between the stored schedule string (a 5-field cron
 * expression, or an interval like "1h") and a friendly UI model the
 * AutomationView renders as a "pick a cadence → pick a time" control.
 *
 * The backend (core's cron-expr.ts) is the source of truth and stays untouched:
 * we only translate the common cases (daily / weekdays / weekly / hourly) into
 * a structured model. Anything we can't model round-trips through {kind:
 * "custom", raw} so power users keep their raw cron and nothing is lost.
 *
 * Cron field order matches core: minute hour dayOfMonth month dayOfWeek,
 * with dayOfWeek 0=Sunday.
 */

export type Schedule =
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; weekday: number; time: string }
  | { kind: "hourly"; everyHours: number }
  | { kind: "custom"; raw: string };

export const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "HH:MM" from minute+hour numbers. */
function toTime(hour: number, minute: number): string {
  return `${pad2(hour)}:${pad2(minute)}`;
}

/** Parse "HH:MM" → {hour, minute}, or null if malformed. */
function fromTime(time: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** Translate a stored schedule string into the UI model. */
export function parseSchedule(raw: string): Schedule {
  const trimmed = raw.trim();

  // Interval form: "<n>h" → hourly. (Other intervals like "1d" fall to custom.)
  const interval = /^(\d+)h$/.exec(trimmed);
  if (interval) {
    return { kind: "hourly", everyHours: Number(interval[1]) };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return { kind: "custom", raw: trimmed };
  const [min, hr, dom, mon, dow] = parts;

  // Hourly: minute=0, hour="*" or "*/n", everything else wildcard.
  if (min === "0" && dom === "*" && mon === "*" && dow === "*") {
    if (hr === "*") return { kind: "hourly", everyHours: 1 };
    const step = /^\*\/(\d+)$/.exec(hr);
    if (step) return { kind: "hourly", everyHours: Number(step[1]) };
  }

  // The day-of-month and month fields must be wildcards for a clean time-based
  // cadence; otherwise it's something we don't model.
  const minute = Number(min);
  const hour = Number(hr);
  const simpleTime =
    /^\d{1,2}$/.test(min) && /^\d{1,2}$/.test(hr) && minute <= 59 && hour <= 23;
  if (simpleTime && dom === "*" && mon === "*") {
    const time = toTime(hour, minute);
    if (dow === "*") return { kind: "daily", time };
    if (dow === "1-5") return { kind: "weekdays", time };
    if (/^[0-6]$/.test(dow)) return { kind: "weekly", weekday: Number(dow), time };
  }

  return { kind: "custom", raw: trimmed };
}

/** Build the stored schedule string from the UI model. */
export function buildSchedule(s: Schedule): string {
  switch (s.kind) {
    case "custom":
      return s.raw.trim();
    case "hourly":
      return s.everyHours === 1 ? "0 * * * *" : `0 */${s.everyHours} * * *`;
    case "daily": {
      const t = fromTime(s.time)!;
      return `${t.minute} ${t.hour} * * *`;
    }
    case "weekdays": {
      const t = fromTime(s.time)!;
      return `${t.minute} ${t.hour} * * 1-5`;
    }
    case "weekly": {
      const t = fromTime(s.time)!;
      return `${t.minute} ${t.hour} * * ${s.weekday}`;
    }
  }
}

/** Short human-readable label for a stored schedule (sidebar / summary). */
export function describeSchedule(raw: string): string {
  const s = parseSchedule(raw);
  switch (s.kind) {
    case "daily":
      return `每天 ${s.time}`;
    case "weekdays":
      return `工作日 ${s.time}`;
    case "weekly":
      return `每${WEEKDAY_LABELS[s.weekday]} ${s.time}`;
    case "hourly":
      return s.everyHours === 1 ? "每小时" : `每 ${s.everyHours} 小时`;
    case "custom":
      return s.raw;
  }
}

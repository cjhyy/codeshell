/**
 * Minimal 5-field cron expression parser + timezone-aware next-trigger
 * calculator. No third-party dependency (core keeps its dep set tight).
 *
 * Fields:  minute(0-59) hour(0-23) dayOfMonth(1-31) month(1-12) dayOfWeek(0-6, 0=Sun)
 * Syntax per field:  star | star-slash-n | a | a-b | a-b-slash-n | comma-lists of those.
 *
 * Timezone handling uses Intl.DateTimeFormat with a timeZone option to derive
 * the wall-clock parts of a candidate UTC instant in the target zone — correct
 * across DST without a tz library. nextCronTime steps minute-by-minute from the
 * reference and returns the first future instant whose wall-clock parts (in tz)
 * match every field. Bounded to ~2 years so an unsatisfiable expression can't
 * loop forever.
 */

export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>; // 1-12
  daysOfWeek: Set<number>; // 0-6, 0=Sunday
  /**
   * Whether the dayOfMonth / dayOfWeek FIELD was restricted (anything other
   * than a bare "*"). Vixie-cron semantics: when BOTH day fields are
   * restricted, a tick matches if EITHER matches (OR); when only one is
   * restricted, the "*" one is ignored and the restricted one governs. We
   * can't recover this from the value Set alone ("*" and an explicit full
   * range both expand to the full set), so we capture it at parse time.
   */
  domRestricted: boolean;
  dowRestricted: boolean;
}

interface FieldSpec {
  min: number;
  max: number;
}

const SPECS: FieldSpec[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day of week
];

/** Cheap check: is this string a 5-field cron expression (vs an interval like "5m")? */
export function isCronExpression(s: string): boolean {
  if (typeof s !== "string") return false;
  const parts = s.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  // Every field must contain only cron field characters.
  return parts.every((p) => /^[\d*/,-]+$/.test(p));
}

function parseField(field: string, spec: FieldSpec): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    // Split optional step: "a-b/n" or "*/n" or "a/n"
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : parseInt(stepPart, 10);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`Invalid cron step in "${field}"`);
    }

    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = spec.min;
      hi = spec.max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      lo = parseInt(a, 10);
      hi = parseInt(b, 10);
    } else {
      lo = parseInt(rangePart, 10);
      hi = lo;
    }

    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      throw new Error(`Invalid cron field "${field}"`);
    }
    if (lo < spec.min || hi > spec.max || lo > hi) {
      throw new Error(
        `cron field "${field}" out of range [${spec.min}-${spec.max}]`,
      );
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Parse a 5-field cron expression into per-field value sets. Throws on invalid input. */
export function parseCronExpression(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron expression must have 5 fields, got ${parts.length}: "${expr}"`);
  }
  return {
    minutes: parseField(parts[0], SPECS[0]),
    hours: parseField(parts[1], SPECS[1]),
    daysOfMonth: parseField(parts[2], SPECS[2]),
    months: parseField(parts[3], SPECS[3]),
    daysOfWeek: parseField(parts[4], SPECS[4]),
    // A bare "*" is unrestricted; anything else (a number, range, list, or even
    // "*/n") restricts the field for the OR rule below.
    domRestricted: parts[2].trim() !== "*",
    dowRestricted: parts[4].trim() !== "*",
  };
}

interface WallClock {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number; // 1-12
  dayOfWeek: number; // 0-6, 0=Sun
}

// Cache one formatter per timezone — constructing Intl.DateTimeFormat is costly.
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Derive the wall-clock parts of a UTC instant `ms` as seen in `timeZone`. */
function wallClockInZone(ms: number, timeZone: string): WallClock {
  const parts = getFormatter(timeZone).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  // hour can come back as "24" at midnight in some environments; normalize.
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0;
  return {
    minute: parseInt(get("minute"), 10),
    hour,
    dayOfMonth: parseInt(get("day"), 10),
    month: parseInt(get("month"), 10),
    dayOfWeek: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
}

function matches(cron: ParsedCron, wc: WallClock): boolean {
  if (!cron.minutes.has(wc.minute)) return false;
  if (!cron.hours.has(wc.hour)) return false;
  if (!cron.months.has(wc.month)) return false;

  // Day-of-month vs day-of-week per Vixie/POSIX cron:
  //   - both restricted → match if EITHER matches (OR)
  //   - only one restricted → that one governs (the "*" one is ignored)
  //   - neither restricted → matches every day
  const domHit = cron.daysOfMonth.has(wc.dayOfMonth);
  const dowHit = cron.daysOfWeek.has(wc.dayOfWeek);
  if (cron.domRestricted && cron.dowRestricted) return domHit || dowHit;
  if (cron.domRestricted) return domHit;
  if (cron.dowRestricted) return dowHit;
  return true;
}

const MINUTE_MS = 60_000;
// ~2 years of minutes — bounds the search for an unsatisfiable expression.
const MAX_STEPS = 2 * 366 * 24 * 60;

/**
 * Return the next UTC instant (ms) strictly after `fromMs` whose wall-clock
 * time in `timeZone` matches `cron`. Returns null if none within ~2 years
 * (e.g. an impossible expression like Feb 30).
 */
export function nextCronTime(
  cron: ParsedCron,
  timeZone: string,
  fromMs: number,
): number | null {
  // Start at the next whole minute strictly after fromMs (cron has minute
  // granularity; we never return the reference instant itself).
  let candidate = Math.floor(fromMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let i = 0; i < MAX_STEPS; i++) {
    const wc = wallClockInZone(candidate, timeZone);
    if (matches(cron, wc)) return candidate;
    candidate += MINUTE_MS;
  }
  return null;
}

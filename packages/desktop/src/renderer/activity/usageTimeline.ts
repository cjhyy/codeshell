import type { UsageSummary } from "@cjhyy/code-shell-core";
import type { UsageRange } from "./usageOverview";

export type UsageTimeRow = NonNullable<UsageSummary["byTime"]>[number];

/** Bucketed usage for the selected range; `rows` are merged across every page read. */
export interface UsageTimeline {
  bucketMs: number;
  /** Added to a timestamp before flooring, so buckets start on local hour/day/week edges. */
  offsetMs: number;
  since?: number;
  until: number;
  rows: UsageTimeRow[];
  /** Bucket edges when they are not evenly spaced (local days and weeks); defaults to fixed. */
  calendar?: BucketCalendar;
}

/** Local time minus UTC at a given instant. */
export type OffsetAt = (at: number) => number;

export interface BucketCalendar {
  /** Start of the bucket containing `at`. */
  startOf(at: number): number;
  /** Start of the bucket after the one beginning at `start`. */
  next(start: number): number;
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
/** Beyond this span daily points are too dense to read, so "all" switches to weeks. */
const WEEKLY_AFTER_MS = 180 * DAY_MS;
/** Offsets are sampled daily this far back when "all" has no known start. */
const ALL_LOOKBACK_MS = 20 * 365 * DAY_MS;

const totalFields = [
  "requests",
  "promptTokens",
  "completionTokens",
  "totalTokens",
  "cacheReadTokens",
  "cacheCreationTokens",
  "knownEstimatedCostUsd",
  "unknownCostRequests",
  "unknownUsageRequests",
  "notSentRequests",
] as const;

export function rangeWindowMs(range: UsageRange): number | undefined {
  if (range === "all") return undefined;
  return range === "24h" ? DAY_MS : (range === "7d" ? 7 : 30) * DAY_MS;
}

export function bucketSizeFor(range: UsageRange): number {
  return range === "24h" || range === "7d" ? HOUR_MS : DAY_MS;
}

export const localOffsetAt: OffsetAt = (at) => -new Date(at).getTimezoneOffset() * 60_000;

export function bucketStartOf(at: number, bucketMs: number, offsetMs: number): number {
  return Math.floor((at + offsetMs) / bucketMs) * bucketMs - offsetMs;
}

export function fixedCalendar(bucketMs: number, offsetMs: number): BucketCalendar {
  return {
    startOf: (at) => bucketStartOf(at, bucketMs, offsetMs),
    next: (start) => start + bucketMs,
  };
}

/**
 * Buckets that begin at local midnight, every `days` days (7 = weeks from Monday).
 * A clock change makes one day 23 or 25 hours long, so edges come from the
 * offset in force at each midnight rather than from a fixed step.
 */
export function localDayCalendar(offsetAt: OffsetAt, days: 1 | 7): BucketCalendar {
  const midnight = (date: number) => {
    const utc = date * DAY_MS;
    const guess = offsetAt(utc);
    // The offset at UTC midnight can differ from the one at local midnight.
    const actual = offsetAt(utc - guess);
    return utc - actual;
  };
  const dateOf = (at: number) => {
    let date = Math.floor((at + offsetAt(at)) / DAY_MS);
    // The epoch began on a Thursday; three more days puts week edges on Monday.
    if (days === 7) date -= (((date + 3) % 7) + 7) % 7;
    return date;
  };
  return {
    startOf: (at) => midnight(dateOf(at)),
    next: (start) => midnight(dateOf(start) + days),
  };
}

/**
 * What to ask the store for. The store buckets with one fixed size and offset,
 * which cannot follow local midnight across a clock change. When a day range
 * crosses one, ask for rows fine enough that every local midnight is a bucket
 * edge and fold them into local days here: same requests, smaller buckets.
 */
export function planBuckets(
  range: UsageRange,
  since: number | undefined,
  until: number,
  offsetAt: OffsetAt,
): { bucketMs: number; queryBucketMs: number; offsetMs: number } {
  const bucketMs = bucketSizeFor(range);
  const offsetMs = offsetAt(until);
  if (bucketMs < DAY_MS) return { bucketMs, queryBucketMs: bucketMs, offsetMs };
  const shifts = new Set<number>();
  for (let at = since ?? until - ALL_LOOKBACK_MS; at < until; at += DAY_MS)
    shifts.add(Math.abs(offsetAt(at) - offsetMs));
  shifts.delete(0);
  if (!shifts.size) return { bucketMs, queryBucketMs: bucketMs, offsetMs };
  const queryBucketMs =
    [HOUR_MS, HOUR_MS / 2, HOUR_MS / 4].find((size) =>
      [...shifts].every((shift) => shift % size === 0),
    ) ?? 5 * 60_000;
  return { bucketMs, queryBucketMs, offsetMs };
}

function rowKey(row: UsageTimeRow): string {
  return JSON.stringify([row.bucketStart, row.provider, row.model, row.providerKind, row.purpose]);
}

/** Pages bucket only their own receipts, so the same bucket can arrive more than once. */
export function mergeTimeRows(target: Map<string, UsageTimeRow>, rows: readonly UsageTimeRow[]) {
  for (const row of rows) {
    const key = rowKey(row);
    const merged = target.get(key);
    if (!merged) {
      target.set(key, { ...row });
      continue;
    }
    for (const field of totalFields) {
      const sum = (merged[field] ?? 0) + (row[field] ?? 0);
      if (field !== "notSentRequests" || sum > 0) merged[field] = sum;
    }
  }
}

export function finishTimeline(
  merged: Map<string, UsageTimeRow>,
  options: {
    range: UsageRange;
    bucketMs: number;
    offsetMs: number;
    offsetAt: OffsetAt;
    since?: number;
    until: number;
  },
): UsageTimeline {
  const { range, offsetMs, offsetAt, since, until } = options;
  let { bucketMs } = options;
  let rows = [...merged.values()];
  let calendar: BucketCalendar | undefined;
  if (bucketMs >= DAY_MS) {
    let first = Infinity;
    for (const row of rows) first = Math.min(first, row.bucketStart);
    const weekly = range === "all" && until - first > WEEKLY_AFTER_MS;
    if (weekly) bucketMs = WEEK_MS;
    calendar = localDayCalendar(offsetAt, weekly ? 7 : 1);
    const folded = new Map<string, UsageTimeRow>();
    mergeTimeRows(
      folded,
      rows.map((row) => ({ ...row, bucketStart: calendar!.startOf(row.bucketStart) })),
    );
    rows = [...folded.values()];
  }
  rows.sort((a, b) => a.bucketStart - b.bucketStart);
  return {
    bucketMs,
    offsetMs,
    ...(since === undefined ? {} : { since }),
    until,
    rows,
    ...(calendar ? { calendar } : {}),
  };
}

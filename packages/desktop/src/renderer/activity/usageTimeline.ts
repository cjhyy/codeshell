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
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
/** Beyond this span daily points are too dense to read, so "all" switches to weeks. */
const WEEKLY_AFTER_MS = 180 * DAY_MS;
/** The epoch began on a Thursday; three more days puts weekly edges on Monday. */
const MONDAY_SHIFT_MS = 3 * DAY_MS;

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

/** Local time minus UTC. One offset serves the whole range, so days across a DST change shift by an hour. */
export function localOffsetMs(at: number): number {
  return -new Date(at).getTimezoneOffset() * 60_000;
}

export function bucketStartOf(at: number, bucketMs: number, offsetMs: number): number {
  return Math.floor((at + offsetMs) / bucketMs) * bucketMs - offsetMs;
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
  options: { range: UsageRange; bucketMs: number; offsetMs: number; since?: number; until: number },
): UsageTimeline {
  const { range, since, until } = options;
  let { bucketMs, offsetMs } = options;
  let rows = [...merged.values()];
  if (range === "all" && rows.length) {
    let first = Infinity;
    for (const row of rows) first = Math.min(first, row.bucketStart);
    if (until - first > WEEKLY_AFTER_MS) {
      bucketMs = WEEK_MS;
      offsetMs += MONDAY_SHIFT_MS;
      const weekly = new Map<string, UsageTimeRow>();
      mergeTimeRows(
        weekly,
        rows.map((row) => ({
          ...row,
          bucketStart: bucketStartOf(row.bucketStart, bucketMs, offsetMs),
        })),
      );
      rows = [...weekly.values()];
    }
  }
  rows.sort((a, b) => a.bucketStart - b.bucketStart);
  return { bucketMs, offsetMs, ...(since === undefined ? {} : { since }), until, rows };
}

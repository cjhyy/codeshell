import { expect, test } from "bun:test";
import type { UsageQuery, UsageSummary } from "@cjhyy/code-shell-core";
import { buildCacheSeries } from "./usageCacheSeries";
import { readUsageOverview, type UsageRange } from "./usageOverview";
import {
  DAY_MS,
  HOUR_MS,
  localDayCalendar,
  type OffsetAt,
  type UsageTimeRow,
} from "./usageTimeline";

const at = (iso: string) => Date.parse(iso);
/** New York in autumn 2026: clocks go back from UTC-4 to UTC-5 at 06:00 UTC on 1 November. */
const FALL_BACK = at("2026-11-01T06:00:00Z");
const SPRING_FORWARD = at("2026-03-08T07:00:00Z");
const newYork: OffsetAt = (time) =>
  (time >= SPRING_FORWARD && time < FALL_BACK ? -4 : -5) * HOUR_MS;
const NOW = at("2026-11-12T15:00:00Z");

const totals = {
  requests: 1,
  promptTokens: 5_000,
  completionTokens: 20,
  totalTokens: 5_020,
  cacheReadTokens: 4_000,
  cacheCreationTokens: 0,
  knownEstimatedCostUsd: 0,
  unknownCostRequests: 0,
  unknownUsageRequests: 0,
};
const row = (iso: string, patch: Partial<UsageTimeRow> = {}): UsageTimeRow => ({
  ...totals,
  provider: "anthropic",
  model: "model-a",
  purpose: "main",
  bucketStart: at(iso),
  ...patch,
});
function summary(byTime: UsageTimeRow[]): UsageSummary {
  return {
    version: 1,
    scope: "store",
    includesChildren: false,
    partial: false,
    persistenceErrors: 0,
    invalidReceipts: 0,
    scannedReceipts: byTime.length,
    ...totals,
    byModel: [],
    bySession: [],
    byPurpose: [],
    byTime,
  };
}
async function read(range: UsageRange, rows: UsageTimeRow[], offsetAt = newYork, now = NOW) {
  const queries: UsageQuery[] = [];
  const overview = await readUsageOverview(
    async (query) => {
      queries.push(query);
      return summary(rows);
    },
    range,
    () => false,
    now,
    offsetAt,
  );
  return { queries, timeline: overview!.timeline };
}

test("a day range crossing a clock change asks for hourly rows and folds them into local days", async () => {
  const { queries, timeline } = await read("30d", [
    row("2026-10-20T03:00:00Z"), // 19 Oct 23:00 EDT
    row("2026-10-20T04:00:00Z"), // 20 Oct 00:00 EDT
    row("2026-11-01T04:00:00Z"), // 1 Nov 00:00 EDT, before the change
    row("2026-11-02T04:00:00Z"), // 1 Nov 23:00 EST, the 25th hour of that day
    row("2026-11-02T05:00:00Z"), // 2 Nov 00:00 EST
    row("2026-11-05T04:00:00Z"), // 4 Nov 23:00 EST
  ]);
  // One pass, same pagination: only the granularity of the rows changes.
  expect(queries).toHaveLength(1);
  expect(queries[0]).toMatchObject({ bucketMs: HOUR_MS, bucketOffsetMs: -5 * HOUR_MS });
  expect(timeline.bucketMs).toBe(DAY_MS);
  expect(
    timeline.rows.map((value) => [new Date(value.bucketStart).toISOString(), value.requests]),
  ).toEqual([
    ["2026-10-19T04:00:00.000Z", 1],
    ["2026-10-20T04:00:00.000Z", 1],
    ["2026-11-01T04:00:00.000Z", 2],
    ["2026-11-02T05:00:00.000Z", 1],
    ["2026-11-04T05:00:00.000Z", 1],
  ]);
});

test("the chart axis follows local days, including the 25-hour one", async () => {
  const { timeline } = await read("30d", [
    row("2026-11-01T04:00:00Z"),
    row("2026-11-02T05:00:00Z"),
  ]);
  const data = buildCacheSeries(timeline, { mainOnly: true });
  const index = data.buckets.indexOf(at("2026-11-01T04:00:00Z"));
  expect(index).toBeGreaterThan(0);
  expect(data.buckets[index + 1]).toBe(at("2026-11-02T05:00:00Z"));
  expect(data.bucketEnds[index]).toBe(at("2026-11-02T05:00:00Z"));
  expect(data.buckets[index] - data.buckets[index - 1]!).toBe(DAY_MS);
  expect(data.buckets.at(-1)).toBe(at("2026-11-12T05:00:00Z"));
  expect(data.buckets[0]).toBe(at("2026-10-13T04:00:00Z"));
  expect(data.series[0]!.points[index]!.rate).toBe(0.8);
  expect(data.series[0]!.points[index + 1]!.rate).toBe(0.8);
});

test("a day range without a clock change keeps the single daily query", async () => {
  const { queries, timeline } = await read(
    "30d",
    [row("2026-12-20T05:00:00Z")],
    newYork,
    at("2026-12-30T15:00:00Z"),
  );
  expect(queries[0]).toMatchObject({ bucketMs: DAY_MS, bucketOffsetMs: -5 * HOUR_MS });
  expect(timeline.rows[0]!.bucketStart).toBe(at("2026-12-20T05:00:00Z"));
});

test("hourly ranges are unaffected by a clock change", async () => {
  const { queries } = await read("7d", [], newYork, at("2026-11-03T15:00:00Z"));
  expect(queries[0]).toMatchObject({ bucketMs: HOUR_MS, bucketOffsetMs: -5 * HOUR_MS });
});

test("a half-hour clock change asks for rows fine enough to land on both midnights", async () => {
  // Lord Howe Island moves between UTC+11 and UTC+10:30.
  const change = at("2026-10-20T00:00:00Z");
  const lordHowe: OffsetAt = (time) => (time < change ? 10.5 : 11) * HOUR_MS;
  const { queries, timeline } = await read(
    "30d",
    [row("2026-10-10T13:30:00Z"), row("2026-10-25T13:00:00Z")],
    lordHowe,
  );
  expect(queries[0]).toMatchObject({ bucketMs: HOUR_MS / 2, bucketOffsetMs: 11 * HOUR_MS });
  expect(timeline.rows.map((value) => new Date(value.bucketStart).toISOString())).toEqual([
    "2026-10-10T13:30:00.000Z",
    "2026-10-25T13:00:00.000Z",
  ]);
});

test("all records in a zone with clock changes fold into weeks that start on local Mondays", async () => {
  const { queries, timeline } = await read("all", [
    row("2026-02-03T04:30:00Z"), // Mon 2 Feb 23:30 EST
    row("2026-02-03T05:00:00Z"), // Tue 3 Feb 00:00 EST, same week
    row("2026-03-10T03:00:00Z"), // Mon 9 Mar 23:00 EDT, the week after the spring change
    row("2026-11-03T04:00:00Z"), // Mon 2 Nov 23:00 EST
  ]);
  expect(queries[0]).toMatchObject({ bucketMs: HOUR_MS });
  expect(queries[0]!.since).toBeUndefined();
  expect(timeline.bucketMs).toBe(7 * DAY_MS);
  expect(
    timeline.rows.map((value) => [new Date(value.bucketStart).toISOString(), value.requests]),
  ).toEqual([
    ["2026-02-02T05:00:00.000Z", 2],
    ["2026-03-09T04:00:00.000Z", 1],
    ["2026-11-02T05:00:00.000Z", 1],
  ]);
});

test("the local-day calendar steps over 23- and 25-hour days", () => {
  const days = localDayCalendar(newYork, 1);
  expect(days.startOf(at("2026-03-08T12:00:00Z"))).toBe(at("2026-03-08T05:00:00Z"));
  expect(days.next(at("2026-03-08T05:00:00Z"))).toBe(at("2026-03-09T04:00:00Z"));
  expect(days.next(at("2026-11-01T04:00:00Z"))).toBe(at("2026-11-02T05:00:00Z"));
  // The last hour before midnight on a long day still belongs to that day.
  expect(days.startOf(at("2026-11-02T04:59:59Z"))).toBe(at("2026-11-01T04:00:00Z"));
  const weeks = localDayCalendar(newYork, 7);
  expect(weeks.startOf(at("2026-11-01T12:00:00Z"))).toBe(at("2026-10-26T04:00:00Z"));
  expect(weeks.next(at("2026-10-26T04:00:00Z"))).toBe(at("2026-11-02T05:00:00Z"));
});

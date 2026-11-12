import { expect, test } from "bun:test";
import type { UsageQuery, UsageSummary } from "@cjhyy/code-shell-core";
import { readUsageOverview, type UsageRange } from "./usageOverview";
import { DAY_MS, HOUR_MS, type UsageTimeRow } from "./usageTimeline";

const totals = {
  requests: 1,
  promptTokens: 100,
  completionTokens: 20,
  totalTokens: 120,
  cacheReadTokens: 50,
  cacheCreationTokens: 0,
  knownEstimatedCostUsd: 0,
  unknownCostRequests: 1,
  unknownUsageRequests: 0,
};
function summary(patch: Partial<UsageSummary> = {}): UsageSummary {
  return {
    version: 1,
    scope: "store",
    includesChildren: false,
    partial: false,
    persistenceErrors: 0,
    invalidReceipts: 0,
    scannedReceipts: 1,
    ...totals,
    byModel: [],
    bySession: [],
    byPurpose: [],
    ...patch,
  };
}
function row(bucketStart: number, patch: Partial<UsageTimeRow> = {}): UsageTimeRow {
  return {
    ...totals,
    provider: "anthropic",
    model: "model-a",
    purpose: "main",
    bucketStart,
    ...patch,
  };
}
const NOW = 400 * DAY_MS + 5 * HOUR_MS;
const OFFSET = 8 * HOUR_MS;

async function read(range: UsageRange, pages: UsageSummary[]) {
  const queries: UsageQuery[] = [];
  const overview = await readUsageOverview(
    async (query) => {
      queries.push(query);
      return pages.shift()!;
    },
    range,
    () => false,
    NOW,
    OFFSET,
  );
  return { queries, timeline: overview!.timeline };
}

test("each range asks for its bucket size aligned to the local offset", async () => {
  const expected: Array<[UsageRange, number, number | undefined]> = [
    ["24h", HOUR_MS, NOW - DAY_MS],
    ["7d", HOUR_MS, NOW - 7 * DAY_MS],
    ["30d", DAY_MS, NOW - 30 * DAY_MS],
    ["all", DAY_MS, undefined],
  ];
  for (const [range, bucketMs, since] of expected) {
    const { queries, timeline } = await read(range, [summary()]);
    expect(queries).toEqual([
      {
        scope: "store",
        until: NOW,
        ...(since === undefined ? {} : { since }),
        limit: 10_000,
        bucketMs,
        bucketOffsetMs: OFFSET,
      },
    ]);
    expect(timeline).toEqual({
      bucketMs,
      offsetMs: OFFSET,
      ...(since === undefined ? {} : { since }),
      until: NOW,
      rows: [],
    });
  }
});

test("bucket rows from different pages merge by bucket, model identity and purpose", async () => {
  const bucket = NOW - 3 * HOUR_MS;
  const { queries, timeline } = await read("7d", [
    summary({
      nextCursor: "a".repeat(64),
      partial: true,
      byTime: [row(bucket), row(bucket, { purpose: "title" }), row(bucket + HOUR_MS)],
    }),
    summary({
      byTime: [
        row(bucket, { notSentRequests: 1 }),
        row(bucket, { model: "model-b" }),
        row(bucket, { providerKind: "external-cli" }),
        row(bucket, { provider: "openrouter" }),
      ],
    }),
  ]);
  expect(queries[1]).toMatchObject({ cursor: "a".repeat(64), bucketMs: HOUR_MS });
  expect(timeline.rows).toHaveLength(6);
  const merged = timeline.rows.find(
    (value) =>
      value.bucketStart === bucket &&
      value.model === "model-a" &&
      value.purpose === "main" &&
      value.provider === "anthropic" &&
      !value.providerKind,
  )!;
  expect(merged).toMatchObject({
    requests: 2,
    promptTokens: 200,
    cacheReadTokens: 100,
    notSentRequests: 1,
  });
  expect(timeline.rows.map((value) => value.bucketStart)).toEqual(
    [...timeline.rows.map((value) => value.bucketStart)].sort((a, b) => a - b),
  );
});

test("a summary without bucket rows leaves an empty timeline instead of failing", async () => {
  const { timeline } = await read("30d", [summary({ byTime: undefined })]);
  expect(timeline.rows).toEqual([]);
});

test("all records stay daily up to about 180 days and fold into local weeks beyond", async () => {
  const day = (ago: number) => Math.floor((NOW + OFFSET) / DAY_MS) * DAY_MS - OFFSET - ago * DAY_MS;
  const short = await read("all", [summary({ byTime: [row(day(170)), row(day(1))] })]);
  expect(short.timeline.bucketMs).toBe(DAY_MS);
  expect(short.timeline.rows).toHaveLength(2);

  const long = await read("all", [
    summary({ byTime: [row(day(200)), row(day(199)), row(day(1)), row(day(0), { model: "b" })] }),
  ]);
  expect(long.timeline.bucketMs).toBe(7 * DAY_MS);
  const starts = [...new Set(long.timeline.rows.map((value) => value.bucketStart))];
  for (const start of starts) {
    // Weekly buckets begin at local midnight on a Monday.
    const local = new Date(start + OFFSET);
    expect([local.getUTCDay(), local.getUTCHours()]).toEqual([1, 0]);
  }
  expect(long.timeline.rows.reduce((sum, value) => sum + value.requests, 0)).toBe(4);
  // The two adjacent old days share a week unless a Monday falls between them.
  expect(long.timeline.rows.length).toBeLessThanOrEqual(4);
  expect(
    long.timeline.rows.every(
      (value) =>
        value.bucketStart ===
        Math.floor((value.bucketStart + long.timeline.offsetMs) / (7 * DAY_MS)) * 7 * DAY_MS -
          long.timeline.offsetMs,
    ),
  ).toBe(true);
});

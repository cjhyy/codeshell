import { expect, test } from "bun:test";
import { buildCacheSeries, cacheVolume } from "./usageCacheSeries";
import { HOUR_MS, type UsageTimeline, type UsageTimeRow } from "./usageTimeline";

const BASE = 1_000 * HOUR_MS;
function row(hour: number, patch: Partial<UsageTimeRow> = {}): UsageTimeRow {
  return {
    requests: 2,
    promptTokens: 10_000,
    completionTokens: 100,
    totalTokens: 10_100,
    cacheReadTokens: 9_000,
    cacheCreationTokens: 0,
    knownEstimatedCostUsd: 0,
    unknownCostRequests: 0,
    unknownUsageRequests: 0,
    provider: "anthropic",
    model: "model-a",
    purpose: "main",
    bucketStart: BASE + hour * HOUR_MS,
    ...patch,
  };
}
function timeline(rows: UsageTimeRow[], patch: Partial<UsageTimeline> = {}): UsageTimeline {
  return {
    bucketMs: HOUR_MS,
    offsetMs: 0,
    since: BASE + 30 * 60_000,
    until: BASE + 4 * HOUR_MS + 10,
    rows,
    ...patch,
  };
}
const rates = (points: Array<{ rate: number | null }>) => points.map((value) => value.rate);

test("buckets run contiguously from the range start to now, with silent hours left as gaps", () => {
  const data = buildCacheSeries(timeline([row(1), row(3, { cacheReadTokens: 1_000 })]), {
    mainOnly: true,
  });
  expect(data.buckets).toEqual([0, 1, 2, 3, 4].map((hour) => BASE + hour * HOUR_MS));
  expect(data.series).toHaveLength(1);
  expect(data.series[0]).toMatchObject({ model: "model-a", slot: 0, other: false });
  expect(rates(data.series[0]!.points)).toEqual([null, 0.9, null, 0.1, null]);
  expect(data.series[0]!.points[1]).toMatchObject({ requests: 2, promptTokens: 10_000 });
});

test("without a range start the axis begins at the first recorded bucket", () => {
  const data = buildCacheSeries(timeline([row(2)], { since: undefined }), { mainOnly: true });
  expect(data.buckets).toEqual([2, 3, 4].map((hour) => BASE + hour * HOUR_MS));
});

test("too little input or nothing sent is a gap rather than a misleading 0% or 100%", () => {
  const data = buildCacheSeries(
    timeline([
      row(0, { promptTokens: 1_999, cacheReadTokens: 0 }),
      row(1, { promptTokens: 2_000, cacheReadTokens: 0 }),
      row(2, { requests: 2, notSentRequests: 2, promptTokens: 0, cacheReadTokens: 0 }),
      row(3, { promptTokens: 5_000, cacheReadTokens: 6_000 }),
    ]),
    { mainOnly: true },
  );
  expect(rates(data.series[0]!.points)).toEqual([null, 0, null, 1, null]);
  // Volume is exact even where the ratio is withheld.
  expect(cacheVolume(data, new Set())[0]).toEqual({ cached: 0, uncached: 1_999 });
  expect(cacheVolume(data, new Set())[3]).toEqual({ cached: 5_000, uncached: 0 });
});

test("the main-conversation filter drops auxiliary calls that never hit the cache", () => {
  const rows = [
    row(1),
    row(1, { purpose: "title", promptTokens: 10_000, cacheReadTokens: 0 }),
    row(2, { model: "aux-only", purpose: "aux_summary", cacheReadTokens: 0 }),
  ];
  const main = buildCacheSeries(timeline(rows), { mainOnly: true });
  expect(main.series.map((entry) => entry.model)).toEqual(["model-a"]);
  expect(main.series[0]!.points[1]!.rate).toBe(0.9);
  const all = buildCacheSeries(timeline(rows), { mainOnly: false });
  expect(all.series.map((entry) => entry.model)).toEqual(["model-a", "aux-only"]);
  expect(all.series[0]!.points[1]).toMatchObject({ rate: 0.45, requests: 4 });
  // The filter changes values, never a model's colour slot.
  expect(all.series[0]!.slot).toBe(main.series[0]!.slot);
});

test("the five largest models keep their own line and the rest combine into one", () => {
  const rows = ["m1", "m2", "m3", "m4", "m5", "m6", "m7"].map((model, index) =>
    row(1, { model, promptTokens: 70_000 - index * 10_000, cacheReadTokens: 7_000 }),
  );
  rows.push(row(2, { model: "m7", promptTokens: 4_000, cacheReadTokens: 4_000 }));
  const data = buildCacheSeries(timeline(rows), { mainOnly: true });
  expect(data.series.map((entry) => [entry.model, entry.slot, entry.other])).toEqual([
    ["m1", 0, false],
    ["m2", 1, false],
    ["m3", 2, false],
    ["m4", 3, false],
    ["m5", 4, false],
    ["", 5, true],
  ]);
  const other = data.series[5]!;
  expect(other.key).toBe("other");
  expect(other.points[1]).toMatchObject({
    promptTokens: 30_000,
    cacheReadTokens: 14_000,
    requests: 4,
  });
  expect(other.points[1]!.rate).toBeCloseTo(14 / 30);
  expect(other.points[2]!.rate).toBe(1);
  expect(other.promptTokens).toBe(34_000);
});

test("models with the same name under different providers stay separate", () => {
  const data = buildCacheSeries(
    timeline([row(1), row(1, { provider: "openrouter", promptTokens: 5_000 })]),
    { mainOnly: true },
  );
  expect(data.series.map((entry) => entry.provider)).toEqual(["anthropic", "openrouter"]);
});

test("CLI aggregates appear only when they carry cache-read data", () => {
  const cli = { providerKind: "external-cli", purpose: "external" as const };
  const without = buildCacheSeries(
    timeline([
      row(1, { ...cli, provider: "codex", model: "cli-turn-aggregate", cacheReadTokens: 0 }),
    ]),
    { mainOnly: false },
  );
  expect(without).toMatchObject({ buckets: [], series: [] });
  const withCache = buildCacheSeries(
    timeline([
      row(1, { ...cli, provider: "claude", model: "cli-turn-aggregate", cacheReadTokens: 0 }),
      row(2, { ...cli, provider: "claude", model: "cli-turn-aggregate" }),
      row(2, { ...cli, provider: "codex", model: "cli-turn-aggregate", cacheReadTokens: 0 }),
    ]),
    { mainOnly: false },
  );
  expect(withCache.series.map((entry) => entry.provider)).toEqual(["claude"]);
  expect(rates(withCache.series[0]!.points)).toEqual([null, 0, 0.9, null, null]);
});

test("no matching rows yields no buckets so the chart can show its empty state", () => {
  expect(buildCacheSeries(timeline([]), { mainOnly: true }).buckets).toEqual([]);
  expect(
    buildCacheSeries(timeline([row(1, { purpose: "title" })]), { mainOnly: true }).series,
  ).toEqual([]);
});

test("volume sums only the series still shown", () => {
  const data = buildCacheSeries(
    timeline([row(1), row(1, { model: "model-b", promptTokens: 4_000, cacheReadTokens: 1_000 })]),
    { mainOnly: true },
  );
  expect(cacheVolume(data, new Set())[1]).toEqual({ cached: 10_000, uncached: 4_000 });
  expect(cacheVolume(data, new Set([data.series[0]!.key]))[1]).toEqual({
    cached: 1_000,
    uncached: 3_000,
  });
});

test("external CLI turns count as main conversation when they carry cache data", () => {
  const cli = { providerKind: "external-cli", purpose: "external" as const, provider: "claude" };
  const rows = [
    row(1, { ...cli, model: "cli-turn-aggregate" }),
    row(2, { ...cli, provider: "codex", model: "cli-turn-aggregate", cacheReadTokens: 0 }),
    row(2, { purpose: "title", cacheReadTokens: 0 }),
  ];
  const main = buildCacheSeries(timeline(rows), { mainOnly: true });
  expect(main.series.map((entry) => [entry.provider, entry.providerKind])).toEqual([
    ["claude", "external-cli"],
  ]);
  expect(main.series[0]!.points[1]!.rate).toBe(0.9);
});

test("auxiliary-only models cannot take a top slot, and slots survive the filter", () => {
  const rows = ["m1", "m2", "m3", "m4", "m5", "m6"].map((model, index) =>
    row(1, { model, promptTokens: 60_000 - index * 10_000 }),
  );
  // Far more input than any main model, but none of it main conversation.
  rows.push(row(1, { model: "aux-big", purpose: "aux_summary", promptTokens: 900_000 }));
  rows.push(row(2, { model: "m6", purpose: "title", promptTokens: 500_000 }));
  const main = buildCacheSeries(timeline(rows), { mainOnly: true });
  expect(main.series.map((entry) => entry.model)).toEqual(["m1", "m2", "m3", "m4", "m5", ""]);
  expect(main.series[5]!.points[1]!.promptTokens).toBe(10_000);
  const all = buildCacheSeries(timeline(rows), { mainOnly: false });
  expect(all.series.map((entry) => [entry.model, entry.slot])).toEqual(
    main.series.map((entry) => [entry.model, entry.slot]),
  );
  expect(all.series[5]!.points[1]!.promptTokens).toBe(910_000);
});

test("models without main-conversation rows fill spare slots by all-purpose input", () => {
  const rows = [
    row(1),
    row(1, { model: "aux-small", purpose: "title", promptTokens: 3_000 }),
    row(1, { model: "aux-big", purpose: "title", promptTokens: 8_000 }),
  ];
  const all = buildCacheSeries(timeline(rows), { mainOnly: false });
  expect(all.series.map((entry) => [entry.model, entry.slot])).toEqual([
    ["model-a", 0],
    ["aux-big", 1],
    ["aux-small", 2],
  ]);
});

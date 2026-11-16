import { isCliUsage } from "./usageOverview";
import { fixedCalendar, type UsageTimeline, type UsageTimeRow } from "./usageTimeline";

/** Below this many input tokens a bucket's ratio is noise, not a caching signal. */
export const MIN_PROMPT_TOKENS = 2_000;
export const MAX_MODEL_SERIES = 5;
const MAX_BUCKETS = 1_000;

export interface CachePoint {
  /** Requests that reached the provider. */
  requests: number;
  promptTokens: number;
  cacheReadTokens: number;
  /** 0–1, or null when the bucket is a gap (nothing sent, or too little input to judge). */
  rate: number | null;
}

export interface CacheSeries {
  key: string;
  provider?: string;
  model: string;
  providerKind?: string;
  /** The combined remainder beyond the top models. */
  other: boolean;
  /** Fixed colour slot: 0–4 by rank in the range, 5 for the remainder. */
  slot: number;
  promptTokens: number;
  /** One entry per bucket, in bucket order. */
  points: CachePoint[];
}

export interface CacheChartData {
  bucketMs: number;
  /** Contiguous bucket starts, oldest first. */
  buckets: number[];
  /** Exclusive end of each bucket; local days are not all the same length. */
  bucketEnds: number[];
  series: CacheSeries[];
}

export interface CacheVolume {
  cached: number;
  uncached: number;
}

const identityKey = (row: Pick<UsageTimeRow, "provider" | "model" | "providerKind">) =>
  JSON.stringify([row.provider, row.model, row.providerKind]);

/** External CLI turns are the user's own conversation, not auxiliary calls. */
const isMainConversation = (row: Pick<UsageTimeRow, "purpose">) =>
  row.purpose === "main" || row.purpose === "external";

function point(): CachePoint {
  return { requests: 0, promptTokens: 0, cacheReadTokens: 0, rate: null };
}

function settle(points: CachePoint[]): number {
  let promptTokens = 0;
  for (const value of points) {
    promptTokens += value.promptTokens;
    value.rate =
      value.requests > 0 && value.promptTokens >= MIN_PROMPT_TOKENS
        ? Math.min(1, value.cacheReadTokens / value.promptTokens)
        : null;
  }
  return promptTokens;
}

/**
 * Turns bucket rows into one hit-rate series per model.
 *
 * Rank (and with it the colour slot) is fixed for the range, independent of the
 * filter, so switching it or hiding a model never repaints another.
 */
export function buildCacheSeries(
  timeline: UsageTimeline,
  options: { mainOnly: boolean },
): CacheChartData {
  const { bucketMs } = timeline;
  const calendar = timeline.calendar ?? fixedCalendar(bucketMs, timeline.offsetMs);
  const empty: CacheChartData = { bucketMs, buckets: [], bucketEnds: [], series: [] };
  // CLI turn aggregates without cache data would only draw a false 0% line.
  const cliCached = new Set<string>();
  for (const row of timeline.rows)
    if (isCliUsage(row) && row.cacheReadTokens > 0) cliCached.add(identityKey(row));
  const eligible = timeline.rows.filter(
    (row) => !isCliUsage(row) || cliCached.has(identityKey(row)),
  );
  const rows = options.mainOnly ? eligible.filter(isMainConversation) : eligible;
  if (!rows.length) return empty;

  let first = timeline.since ?? Infinity;
  if (timeline.since === undefined)
    for (const row of rows) first = Math.min(first, row.bucketStart);
  const last = calendar.startOf(timeline.until);
  let buckets: number[] = [];
  for (let start = calendar.startOf(first); start <= last; start = calendar.next(start))
    buckets.push(start);
  buckets = buckets.slice(-MAX_BUCKETS);
  const bucketEnds = buckets.map((start) => calendar.next(start));
  const indexOf = new Map(buckets.map((start, index) => [start, index]));

  // One ranking for the whole range: main-conversation input first, so a model
  // with only auxiliary calls cannot take a slot; all-purpose input orders the rest.
  const rank = new Map<string, { main: number; all: number }>();
  for (const row of eligible) {
    const key = identityKey(row);
    const totals = rank.get(key) ?? { main: 0, all: 0 };
    totals.all += row.promptTokens;
    if (isMainConversation(row)) totals.main += row.promptTokens;
    rank.set(key, totals);
  }
  const ranked = [...rank].sort(
    (a, b) => b[1].main - a[1].main || b[1].all - a[1].all || (a[0] < b[0] ? -1 : 1),
  );
  const slots = new Map(ranked.slice(0, MAX_MODEL_SERIES).map(([key], index) => [key, index]));

  const series = new Map<string, CacheSeries>();
  for (const row of rows) {
    const index = indexOf.get(row.bucketStart);
    if (index === undefined) continue;
    const sent = row.requests - (row.notSentRequests ?? 0);
    if (sent <= 0) continue;
    const identity = identityKey(row);
    const slot = slots.get(identity);
    const key = slot === undefined ? "other" : identity;
    let entry = series.get(key);
    if (!entry) {
      entry =
        slot === undefined
          ? { key, model: "", other: true, slot: MAX_MODEL_SERIES, promptTokens: 0, points: [] }
          : {
              key,
              provider: row.provider,
              model: row.model,
              ...(row.providerKind ? { providerKind: row.providerKind } : {}),
              other: false,
              slot,
              promptTokens: 0,
              points: [],
            };
      entry.points = buckets.map(point);
      series.set(key, entry);
    }
    const target = entry.points[index]!;
    target.requests += sent;
    target.promptTokens += row.promptTokens;
    target.cacheReadTokens += row.cacheReadTokens;
  }
  if (!series.size) return empty;
  for (const entry of series.values()) entry.promptTokens = settle(entry.points);
  return {
    bucketMs,
    buckets,
    bucketEnds,
    series: [...series.values()].sort((a, b) => a.slot - b.slot),
  };
}

/** Input volume per bucket for the series still shown; gaps count here because volume is exact. */
export function cacheVolume(data: CacheChartData, hidden: ReadonlySet<string>): CacheVolume[] {
  return data.buckets.map((_, index) => {
    let prompt = 0;
    let cached = 0;
    for (const entry of data.series) {
      if (hidden.has(entry.key)) continue;
      prompt += entry.points[index]!.promptTokens;
      cached += entry.points[index]!.cacheReadTokens;
    }
    cached = Math.min(cached, prompt);
    return { cached, uncached: prompt - cached };
  });
}

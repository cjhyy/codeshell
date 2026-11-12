import type { CacheSeries } from "./usageCacheSeries";
import { DAY_MS } from "./usageTimeline";

export const seriesColour = (entry: Pick<CacheSeries, "slot">) => `var(--cs-viz-${entry.slot + 1})`;

export function formatRate(rate: number): string {
  return `${Math.round(rate * 1_000) / 10}%`;
}

export interface CacheFormatters {
  compact(value: number): string;
  full(value: number): string;
  /** The span one bucket covers, for tooltips and the table. */
  period(start: number, bucketMs: number): string;
  /** A short axis label for a bucket start. */
  tick(start: number, bucketMs: number, daysOnly: boolean): string;
}

export function cacheFormatters(lang: string): CacheFormatters {
  const locale = lang === "zh" ? "zh-CN" : "en-US";
  const compact = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
  const full = new Intl.NumberFormat(locale);
  const day = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" });
  const shortDay = new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" });
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return {
    compact: (value) => compact.format(value),
    full: (value) => full.format(value),
    period(start, bucketMs) {
      if (bucketMs < DAY_MS)
        return `${day.format(start)} ${time.format(start)}–${time.format(start + bucketMs)}`;
      if (bucketMs === DAY_MS) return day.format(start);
      // The last instant of the bucket still belongs to its final day.
      return `${day.format(start)} – ${day.format(start + bucketMs - 1)}`;
    },
    tick: (start, bucketMs, daysOnly) =>
      bucketMs < DAY_MS && !daysOnly ? time.format(start) : shortDay.format(start),
  };
}

/** Indices that get an x-axis label, spaced so neighbouring labels never touch. */
export function tickIndices(buckets: readonly number[], bucketMs: number, step: number) {
  const minGap = 56;
  const hourly = bucketMs < DAY_MS;
  // Across several days of hourly buckets, label local midnights rather than arbitrary hours.
  const daysOnly = hourly && buckets.length * bucketMs > 2 * DAY_MS;
  let candidates = buckets.map((_, index) => index);
  let spacing = step;
  if (daysOnly) {
    candidates = candidates.filter((index) => new Date(buckets[index]!).getHours() === 0);
    spacing = step * (DAY_MS / bucketMs);
  }
  const every = Math.max(1, Math.ceil(minGap / spacing));
  return { daysOnly, indices: candidates.filter((_, index) => index % every === 0) };
}

/** A round axis maximum at or above `value`. */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const factor of [1, 2, 5, 10]) if (value <= factor * magnitude) return factor * magnitude;
  return 10 * magnitude;
}

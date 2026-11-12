import type { UsageQuery, UsageSummary } from "@cjhyy/code-shell-core";
import {
  bucketSizeFor,
  finishTimeline,
  localOffsetMs,
  mergeTimeRows,
  rangeWindowMs,
  type UsageTimeline,
  type UsageTimeRow,
} from "./usageTimeline";

type UsageIdentity = Pick<UsageSummary["byModel"][number], "provider" | "model" | "providerKind">;
type UsageTotals = Pick<UsageSummary, (typeof fields)[number]>;

export type UsageRange = "24h" | "7d" | "30d" | "all";
export interface UsageOverview {
  totals: UsageTotals;
  models: Array<UsageTotals & UsageIdentity>;
  partial: boolean;
  scannedReceipts: number;
  capturedAt: number;
  /** Per-bucket rows behind the cache hit-rate chart. */
  timeline: UsageTimeline;
}

const fields = [
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

function emptyTotals(): UsageTotals {
  return Object.fromEntries(fields.map((field) => [field, 0])) as unknown as UsageTotals;
}

function addTotals(target: UsageTotals, source: UsageTotals): void {
  for (const field of fields) target[field] = (target[field] ?? 0) + (source[field] ?? 0);
}

/** Only the history page asks for aggregates; every page stays on the history worker. */
export async function readUsageOverview(
  read: (query: UsageQuery) => Promise<UsageSummary>,
  range: UsageRange,
  cancelled: () => boolean,
  capturedAt = Date.now(),
  offsetMs = localOffsetMs(capturedAt),
): Promise<UsageOverview | undefined> {
  const windowMs = rangeWindowMs(range);
  const since = windowMs === undefined ? undefined : Math.max(0, capturedAt - windowMs);
  const bucketMs = bucketSizeFor(range);
  const timeRows = new Map<string, UsageTimeRow>();
  const totals = emptyTotals();
  const models = new Map<string, UsageTotals & UsageIdentity>();
  const seen = new Set<string>();
  let cursor: string | undefined;
  let partial = false;
  let complete = false;
  let scannedReceipts = 0;
  // A bounded refresh cannot loop forever if a remote/corrupt store repeats a cursor.
  for (let page = 0; page < 50; page++) {
    if (cancelled()) return undefined;
    const summary = await read({
      scope: "store",
      until: capturedAt,
      ...(since === undefined ? {} : { since }),
      limit: 10_000,
      bucketMs,
      bucketOffsetMs: offsetMs,
      ...(cursor ? { cursor } : {}),
    });
    if (cancelled()) return undefined;
    addTotals(totals, summary);
    scannedReceipts += summary.scannedReceipts;
    partial ||= summary.persistenceErrors > 0 || summary.invalidReceipts > 0;
    mergeTimeRows(timeRows, summary.byTime ?? []);
    for (const model of summary.byModel) {
      const key = JSON.stringify([model.provider, model.model, model.providerKind]);
      let aggregate = models.get(key);
      if (!aggregate) {
        aggregate = {
          ...emptyTotals(),
          provider: model.provider,
          model: model.model,
          ...(model.providerKind ? { providerKind: model.providerKind } : {}),
        };
        models.set(key, aggregate);
      }
      addTotals(aggregate, model);
    }
    if (!summary.nextCursor) {
      // Store-scope intermediate pages use `partial` for pagination. Only the
      // completed page can also expose a listing cap without another cursor.
      partial ||= summary.partial;
      complete = true;
      break;
    }
    if (seen.has(summary.nextCursor)) throw new Error("Usage history returned a repeated cursor");
    seen.add(summary.nextCursor);
    cursor = summary.nextCursor;
  }
  return {
    totals,
    models: [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    partial: partial || !complete,
    scannedReceipts,
    capturedAt,
    timeline: finishTimeline(timeRows, { range, bucketMs, offsetMs, since, until: capturedAt }),
  };
}

export function isCliUsage(model: UsageIdentity): boolean {
  return model.providerKind === "external-cli";
}

export function hasRecordedTokenUsage(
  totals: Pick<UsageTotals, "requests" | "unknownUsageRequests" | "notSentRequests">,
): boolean {
  const sent = Math.max(0, totals.requests - (totals.notSentRequests ?? 0));
  return sent === 0 || totals.unknownUsageRequests < sent;
}

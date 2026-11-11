import { expect, test } from "bun:test";
import type { UsageQuery, UsageSummary } from "@cjhyy/code-shell-core";
import { hasRecordedTokenUsage, isCliUsage, readUsageOverview } from "./usageOverview";

export function usageFixture(patch: Partial<UsageSummary> = {}): UsageSummary {
  return {
    version: 1,
    scope: "store",
    includesChildren: false,
    partial: false,
    persistenceErrors: 0,
    invalidReceipts: 0,
    scannedReceipts: 1,
    requests: 1,
    promptTokens: 100,
    completionTokens: 20,
    totalTokens: 120,
    cacheReadTokens: 50,
    cacheCreationTokens: 0,
    knownEstimatedCostUsd: 0,
    unknownCostRequests: 1,
    unknownUsageRequests: 0,
    byModel: [],
    bySession: [],
    byPurpose: [],
    ...patch,
  };
}

test("usage overview follows empty filtered pages and merges model totals without mixing CLI units", async () => {
  const queries: UsageQuery[] = [];
  const api = { ...usageFixture(), provider: "openai", model: "model-a" };
  const cli = {
    ...usageFixture(),
    provider: "codex",
    model: "aggregate",
    providerKind: "external-cli",
  };
  const pages = [
    usageFixture({
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      unknownCostRequests: 0,
      nextCursor: "a".repeat(64),
      partial: true,
    }),
    usageFixture({ byModel: [api], nextCursor: "b".repeat(64), partial: true }),
    usageFixture({ byModel: [api], nextCursor: "c".repeat(64), partial: true }),
    usageFixture({ byModel: [cli] }),
  ];
  const result = await readUsageOverview(
    async (query) => {
      queries.push(query);
      return pages.shift()!;
    },
    "7d",
    () => false,
    1_000_000_000,
  );
  expect(queries).toHaveLength(4);
  expect(queries.map((query) => query.until)).toEqual(Array(4).fill(1_000_000_000));
  expect(queries.every((query) => query.since === 1_000_000_000 - 7 * 86_400_000)).toBe(true);
  expect(queries[1]!.cursor).toBe("a".repeat(64));
  expect(result!.totals).toMatchObject({ requests: 3, totalTokens: 360, cacheReadTokens: 150 });
  expect(result!.models).toHaveLength(2);
  expect(result!.models.find(isCliUsage)!.requests).toBe(1);
  expect(result!.models.find((row) => !isCliUsage(row))!.requests).toBe(2);
  expect(result!.partial).toBe(false);
});

test("reading every page does not hide actual invalid records or persistence failures", async () => {
  const pages = [
    usageFixture({ invalidReceipts: 1, partial: true, nextCursor: "a".repeat(64) }),
    usageFixture(),
  ];
  const result = await readUsageOverview(
    async () => pages.shift()!,
    "all",
    () => false,
  );
  expect(result!.partial).toBe(true);
});

test("preflight zero receipts cannot turn unknown transmitted usage into a zero", () => {
  expect(hasRecordedTokenUsage({ requests: 2, notSentRequests: 1, unknownUsageRequests: 1 })).toBe(
    false,
  );
  expect(hasRecordedTokenUsage({ requests: 1, notSentRequests: 1, unknownUsageRequests: 0 })).toBe(
    true,
  );
  expect(hasRecordedTokenUsage({ requests: 3, notSentRequests: 1, unknownUsageRequests: 1 })).toBe(
    true,
  );
});

test("obsolete usage reads stop before requesting another page", async () => {
  let cancelled = false;
  let calls = 0;
  const result = await readUsageOverview(
    async () => {
      calls++;
      cancelled = true;
      return usageFixture({ nextCursor: "a".repeat(64) });
    },
    "all",
    () => cancelled,
  );
  expect(calls).toBe(1);
  expect(result).toBeUndefined();
});

test("repeated cursors fail instead of showing duplicated totals", async () => {
  let calls = 0;
  await expect(
    readUsageOverview(
      async () => {
        calls++;
        return usageFixture({ nextCursor: "a".repeat(64) });
      },
      "all",
      () => false,
    ),
  ).rejects.toThrow("repeated cursor");
  expect(calls).toBe(2);
});

test("an incomplete scan remains explicitly partial and refresh work stays bounded", async () => {
  let calls = 0;
  const result = await readUsageOverview(
    async () =>
      usageFixture({
        nextCursor: (++calls).toString(16).padStart(64, "0"),
      }),
    "all",
    () => false,
  );
  expect(calls).toBe(50);
  expect(result!.partial).toBe(true);
});

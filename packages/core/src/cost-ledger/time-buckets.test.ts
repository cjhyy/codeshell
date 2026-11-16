import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageLedger } from "./store.js";
import type { UsagePurpose } from "./types.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codeshell-usage-buckets-"));
  roots.push(root);
  let clock = 0;
  const ledger = new UsageLedger({ storageDir: root, now: () => clock });
  const bill = (
    at: number,
    options: {
      model?: string;
      provider?: string;
      purpose?: UsagePurpose;
      prompt?: number;
      cached?: number;
    } = {},
  ) => {
    clock = at;
    const receipt = ledger.begin(ledger.owner("sid", "run", [], options.purpose ?? "main"), {
      provider: options.provider ?? "anthropic",
      model: options.model ?? "model-a",
    });
    const prompt = options.prompt ?? 1_000;
    ledger.settle(receipt, {
      promptTokens: prompt,
      completionTokens: 10,
      totalTokens: prompt + 10,
      cacheReadTokens: options.cached ?? 0,
    });
    ledger.finish(receipt, "completed");
    return receipt;
  };
  return { ledger, bill };
}

test("time buckets are absent unless a bucket size is requested", () => {
  const { ledger, bill } = fixture();
  bill(10 * HOUR);
  expect(ledger.summary({ scope: "store" }).byTime).toBeUndefined();
  expect(ledger.summary({ scope: "store", bucketMs: HOUR }).byTime).toHaveLength(1);
});

test("receipts land in half-open buckets split by model identity and purpose", () => {
  const { ledger, bill } = fixture();
  bill(10 * HOUR, { prompt: 4_000, cached: 3_000 });
  bill(11 * HOUR - 1, { prompt: 1_000, cached: 500 });
  bill(11 * HOUR, { prompt: 2_000, cached: 0 });
  bill(10 * HOUR + 5, { purpose: "title", prompt: 300 });
  bill(10 * HOUR + 6, { model: "model-b", prompt: 700, cached: 70 });
  const summary = ledger.summary({ scope: "store", bucketMs: HOUR });
  const rows = [...summary.byTime!].sort(
    (a, b) => a.bucketStart - b.bucketStart || a.promptTokens - b.promptTokens,
  );
  expect(
    rows.map((row) => [
      row.bucketStart,
      row.model,
      row.purpose,
      row.requests,
      row.promptTokens,
      row.cacheReadTokens,
    ]),
  ).toEqual([
    [10 * HOUR, "model-a", "title", 1, 300, 0],
    [10 * HOUR, "model-b", "main", 1, 700, 70],
    [10 * HOUR, "model-a", "main", 2, 5_000, 3_500],
    [11 * HOUR, "model-a", "main", 1, 2_000, 0],
  ]);
  expect(rows[0]).toMatchObject({ provider: "anthropic", totalTokens: 310 });
  // The time dimension is another view of the same receipts, not extra usage.
  expect(rows.reduce((sum, row) => sum + row.promptTokens, 0)).toBe(summary.promptTokens);
  expect(summary.byModel).toHaveLength(2);
});

test("an offset aligns daily buckets to the viewer's local midnight", () => {
  const { ledger, bill } = fixture();
  const offset = 8 * HOUR; // UTC+8: local midnight is 16:00 UTC of the previous day.
  bill(3 * DAY + 15 * HOUR + 59 * 60_000);
  bill(3 * DAY + 16 * HOUR);
  bill(4 * DAY + 15 * HOUR);
  const utc = ledger.summary({ scope: "store", bucketMs: DAY }).byTime!;
  expect(utc.map((row) => [row.bucketStart, row.requests]).sort()).toEqual([
    [3 * DAY, 2],
    [4 * DAY, 1],
  ]);
  const local = ledger.summary({ scope: "store", bucketMs: DAY, bucketOffsetMs: offset }).byTime!;
  expect(local.map((row) => [row.bucketStart, row.requests]).sort()).toEqual([
    [2 * DAY + 16 * HOUR, 1],
    [3 * DAY + 16 * HOUR, 2],
  ]);
  const west = ledger.summary({ scope: "store", bucketMs: DAY, bucketOffsetMs: -5 * HOUR }).byTime!;
  expect(west.map((row) => row.bucketStart).sort()).toEqual([
    3 * DAY + 5 * HOUR,
    4 * DAY + 5 * HOUR,
  ]);
});

test("each page buckets only its own receipts so callers can merge pages", () => {
  const { ledger, bill } = fixture();
  for (let index = 0; index < 5; index++) bill(10 * HOUR + index, { prompt: 100 });
  const merged = new Map<number, number>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = ledger.summary({ scope: "store", bucketMs: HOUR, limit: 2, cursor });
    pages++;
    expect(page.byTime!.reduce((sum, row) => sum + row.requests, 0)).toBe(page.requests);
    for (const row of page.byTime!)
      merged.set(row.bucketStart, (merged.get(row.bucketStart) ?? 0) + row.requests);
    cursor = page.nextCursor;
  } while (cursor);
  expect(pages).toBe(3);
  expect([...merged]).toEqual([[10 * HOUR, 5]]);
});

test("runtime and session scopes bucket the receipts they already select", () => {
  const { ledger, bill } = fixture();
  bill(10 * HOUR);
  bill(12 * HOUR);
  for (const query of [{}, { scope: "session" as const, sessionId: "sid" }]) {
    const rows = ledger.summary({ ...query, bucketMs: HOUR, since: 11 * HOUR }).byTime!;
    expect(rows.map((row) => row.bucketStart)).toEqual([12 * HOUR]);
  }
});

test("malformed bucket parameters are rejected like other query fields", () => {
  const { ledger } = fixture();
  for (const invalid of [
    { bucketMs: 299_999 },
    { bucketMs: 0 },
    { bucketMs: -HOUR },
    { bucketMs: Number.NaN },
    { bucketMs: Number.POSITIVE_INFINITY },
    { bucketMs: HOUR + 0.5 },
    { bucketMs: "3600000" },
    { bucketMs: null },
    { bucketMs: 367 * DAY },
    { bucketMs: HOUR, bucketOffsetMs: Number.NaN },
    { bucketMs: HOUR, bucketOffsetMs: 0.5 },
    { bucketMs: HOUR, bucketOffsetMs: 8 * DAY },
    { bucketMs: HOUR, bucketOffsetMs: -8 * DAY },
    { bucketMs: HOUR, bucketOffsetMs: "0" },
    { bucketOffsetMs: HOUR },
  ]) {
    expect(() => ledger.summary(invalid as never)).toThrow("Invalid usage query");
  }
  expect(ledger.summary({ bucketMs: 300_000, bucketOffsetMs: -7 * DAY }).byTime).toEqual([]);
});

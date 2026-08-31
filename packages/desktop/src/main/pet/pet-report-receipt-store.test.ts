import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PetReportReceiptStore } from "./pet-report-receipt-store.js";

const roots: string[] = [];

function fixture(): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "codeshell-pet-report-receipt-"));
  roots.push(root);
  return { root, file: join(root, "receipts.json") };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PetReportReceiptStore", () => {
  it("deduplicates a delivered report across process-like instances", async () => {
    const { file } = fixture();
    const reportId = "a".repeat(32);
    const first = new PetReportReceiptStore(file, () => 10);
    expect(await first.has(reportId)).toBe(false);
    await first.mark(reportId);

    const restarted = new PetReportReceiptStore(file, () => 20);
    expect(await restarted.has(reportId)).toBe(true);
    await restarted.mark(reportId);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([{ reportId, deliveredAt: 10 }]);
  });

  it("fails closed without overwriting malformed receipt history", async () => {
    const { file } = fixture();
    writeFileSync(file, '{"broken":');
    const store = new PetReportReceiptStore(file);

    await expect(store.has("b".repeat(32))).rejects.toThrow();
    await expect(store.mark("b".repeat(32))).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe('{"broken":');
  });
});

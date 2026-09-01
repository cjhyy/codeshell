import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

  it("quarantines malformed history and continues delivering", async () => {
    const { root, file } = fixture();
    writeFileSync(file, '{"broken":');
    const store = new PetReportReceiptStore(file);

    const reportId = "b".repeat(32);
    expect(await store.has(reportId)).toBe(false);
    await store.mark(reportId);

    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([expect.objectContaining({ reportId })]);
    const quarantined = readdirSync(root).find((name) => name.endsWith(".corrupt"));
    expect(quarantined).toBeDefined();
    expect(readFileSync(join(root, quarantined!), "utf8")).toBe('{"broken":');
  });

  it("preserves valid receipts while isolating malformed rows", async () => {
    const { root, file } = fixture();
    const delivered = "c".repeat(32);
    writeFileSync(
      file,
      JSON.stringify([{ reportId: delivered, deliveredAt: 5 }, { broken: true }]),
    );
    const store = new PetReportReceiptStore(file, () => 10);

    expect(await store.has(delivered)).toBe(true);
    await store.mark("d".repeat(32));

    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([
      { reportId: delivered, deliveredAt: 5 },
      { reportId: "d".repeat(32), deliveredAt: 10 },
    ]);
    expect(readdirSync(root).some((name) => name.endsWith(".corrupt"))).toBe(true);
  });
});

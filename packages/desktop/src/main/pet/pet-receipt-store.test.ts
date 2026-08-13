import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PetReceiptStore } from "./pet-receipt-store";

describe("PetReceiptStore", () => {
  test("dedupes after a store restart without persisting notification content", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeshell-pet-receipts-"));
    try {
      const file = join(root, "receipts.json");
      const first = new PetReceiptStore(file, () => 10);
      first.mark("local-user\u0000work-a\u0000req-a\u0000pending", "dismissed");
      await first.flush();
      const second = new PetReceiptStore(file, () => 20);
      await second.load();
      expect(second.has("local-user\u0000work-a\u0000req-a\u0000pending")).toBe(true);
      expect(second.has("secret prompt")).toBe(false);
      if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects unbounded receipt fields", () => {
    const store = new PetReceiptStore("/unused", () => 1);
    expect(() => store.mark("x".repeat(4_097))).toThrow(/invalid/);
    expect(() => store.mark("key", "x".repeat(129))).toThrow(/invalid/);
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PetReceiptStore } from "./pet-receipt-store";
import { storedAttentionReceipts } from "../../host/composition/mimi-attention-receipts.js";

describe("PetReceiptStore", () => {
  test("concurrent claims and restarts dedupe without storing notification content", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeshell-pet-receipts-"));
    try {
      const file = join(root, "receipts.json");
      const first = new PetReceiptStore(file, () => 10);
      const claim = {
        type: "claim",
        rows: [{ key: "local-user\0work-a\0req-a\0pending", state: "surfaced" }],
      } as const;
      const cmd = () => ({ type: claim.type, rows: [...claim.rows] });
      const [a, b] = await Promise.all([first.write(cmd()), first.write(cmd())]);
      expect(a).toEqual([claim.rows[0].key]);
      expect(b).toEqual([]);
      const second = new PetReceiptStore(file, () => 20);
      expect(await second.write(cmd())).toEqual([]);
      const fail = async () => {
        throw Error("write failed");
      };
      const extra = {
        type: "claim" as const,
        rows: [{ key: "second", state: "surfaced" as const }],
      };
      await expect(second.write(extra, fail)).rejects.toThrow("write failed");
      expect(await second.write(extra)).toEqual(["second"]);
      if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects revoked documents and unbounded receipt fields before creating state", async () => {
    const owner = storedAttentionReceipts("/unused");
    const permit = new Int32Array(new SharedArrayBuffer(4));
    Atomics.store(permit, 0, -1);
    expect(() =>
      owner({ call: { type: "claim", rows: [{ key: "one", state: "surfaced" }] }, permit }),
    ).toThrow(/expired/);
    const store = new PetReceiptStore("/unused", () => 1);
    expect(() =>
      store.write({ type: "mark", rows: [{ key: "x".repeat(4_097), state: "seen" }] }),
    ).toThrow(/invalid/);
  });
});

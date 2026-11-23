import { renameSync } from "node:fs";
import { join } from "node:path";
import { PetReceiptStore } from "../../main/pet/pet-receipt-store.js";
import type { AttentionReceiptWrite } from "../../shared/mimi-attention.js";
import { claimBusinessCommit } from "./business-calls.js";

export function storedAttentionReceipts(root: string) {
  const store = new PetReceiptStore(join(root, "attention-receipts.json"));
  return ({ call, permit }: { call: AttentionReceiptWrite; permit: Int32Array }) => {
    if (!(permit instanceof Int32Array) || Atomics.load(permit, 0) < 0)
      throw Error("Mimi receipt grant expired");
    return store.write(call, async (from, to) => {
      claimBusinessCommit(permit);
      renameSync(from, to);
    });
  };
}

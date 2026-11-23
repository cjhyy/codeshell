import { MimiAttentionTracker } from "../../../host/composition/mimi-attention-tracker.js";
import type { PetAttentionOptions } from "../pet-notice-types.js";

export function testAttention(source: PetAttentionOptions["source"], now: () => number) {
  const receipts = new Set<string>();
  const tracker = new MimiAttentionTracker({
    source,
    now,
    report: (error) => {
      throw error;
    },
    claim: async (rows) => {
      const keys = rows.map((row) => row.key).filter((key) => !receipts.has(key));
      for (const key of keys) receipts.add(key);
      return keys;
    },
  });
  return Object.assign(tracker, {
    markReceipts(keys: readonly string[]) {
      for (const key of keys) receipts.add(key);
    },
  });
}

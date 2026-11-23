import type { AttentionReceiptWrite } from "../../shared/mimi-attention.js";
import { readBoundedJson, writeOwnerJsonAtomic } from "./bounded-json-store.js";

interface ReceiptRecord {
  key: string;
  state: string;
  at: number;
}

const MAX_BYTES = 1024 * 1024;
export const MAX_RECEIPTS = 1_000;

function validKey(key: unknown): key is string {
  return typeof key === "string" && key.length > 0 && key.length <= 4_096;
}
function validState(state: unknown): state is string {
  return (
    typeof state === "string" && state.length > 0 && state.length <= 128 && !state.includes("\0")
  );
}

/** The storage worker serializes claims and never exposes a receipt before its replacement commits. */
export class PetReceiptStore {
  private records?: Map<string, ReceiptRecord>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {}

  private async load() {
    if (this.records) return this.records;
    const records = new Map<string, ReceiptRecord>();
    // As in 0.11, missing/corrupt history permits a fresh surface.
    const value = await readBoundedJson(this.path, MAX_BYTES).catch(() => undefined);
    if (Array.isArray(value))
      for (const row of value.slice(-MAX_RECEIPTS)) {
        if (
          row &&
          validKey(row.key) &&
          validState(row.state) &&
          Number.isSafeInteger(row.at) &&
          row.at >= 0
        )
          records.set(row.key, { key: row.key, state: row.state, at: row.at });
      }
    this.records = records;
    return records;
  }

  write(call: AttentionReceiptWrite, replaceFile?: (from: string, to: string) => Promise<void>) {
    if (
      !call ||
      !["claim", "mark"].includes(call.type) ||
      !Array.isArray(call.rows) ||
      call.rows.length > MAX_RECEIPTS ||
      call.rows.some(
        (row) =>
          !row ||
          !validKey(row.key) ||
          !["seen", "dismissed", "surfaced", "suppressed-active"].includes(row.state),
      )
    )
      throw Error("invalid Pet attention receipt");
    const task = this.queue.then(async () => {
      const next = new Map(await this.load());
      const added: string[] = [];
      const at = this.now();
      if (!Number.isSafeInteger(at) || at < 0) throw Error("invalid Pet receipt timestamp");
      for (const { key, state } of call.rows) {
        if (call.type === "claim" && next.has(key)) continue;
        added.push(key);
        next.set(key, { key, state, at });
      }
      if (added.length) {
        while (next.size > MAX_RECEIPTS) next.delete(next.keys().next().value!);
        // Long but valid legacy keys must not fill the file and prevent future claims.
        const rows = [...next.values()];
        let bytes =
          2 + rows.reduce((sum, row) => sum + 1 + Buffer.byteLength(JSON.stringify(row)), 0);
        for (const row of rows) {
          if (bytes <= MAX_BYTES) break;
          next.delete(row.key);
          bytes -= Buffer.byteLength(JSON.stringify(row)) + 1;
        }
        await writeOwnerJsonAtomic(this.path, [...next.values()], MAX_BYTES, {
          compact: true,
          ...(replaceFile && { replaceFile }),
        });
        this.records = next;
      }
      return added;
    });
    this.queue = task.catch(() => {});
    return task;
  }
}

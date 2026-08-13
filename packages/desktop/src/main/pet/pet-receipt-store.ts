import { readBoundedJson, writeOwnerJsonAtomic } from "./bounded-json-store.js";

interface ReceiptRecord {
  key: string;
  state: string;
  at: number;
}

const MAX_RECEIPT_FILE_BYTES = 1024 * 1024;

export class PetReceiptStore {
  private readonly records = new Map<string, ReceiptRecord>();
  private writeQueue = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    try {
      const parsed = await readBoundedJson(this.filePath, MAX_RECEIPT_FILE_BYTES);
      if (!Array.isArray(parsed)) return;
      for (const item of parsed.slice(-1_000)) {
        const record = item as Partial<ReceiptRecord>;
        if (
          validReceiptKey(record.key) &&
          validReceiptState(record.state) &&
          Number.isSafeInteger(record.at) &&
          (record.at ?? -1) >= 0
        ) {
          this.records.set(record.key, record as ReceiptRecord);
        }
      }
    } catch {
      // Missing/corrupt receipt history means notifications may surface once again.
    }
  }

  has(key: string): boolean {
    return validReceiptKey(key) && this.records.has(key);
  }

  mark(key: string, state = "seen"): void {
    if (!validReceiptKey(key) || !validReceiptState(state)) {
      throw new Error("invalid Pet receipt");
    }
    const at = this.now();
    if (!Number.isSafeInteger(at) || at < 0) throw new Error("invalid Pet receipt timestamp");
    this.records.set(key, { key, state, at });
    while (this.records.size > 1_000) this.records.delete(this.records.keys().next().value!);
    const write = this.writeQueue.catch(() => undefined).then(() => this.persist());
    void write.catch(() => undefined);
    this.writeQueue = write;
  }

  flush(): Promise<void> {
    return this.writeQueue;
  }

  private async persist(): Promise<void> {
    await writeOwnerJsonAtomic(this.filePath, [...this.records.values()], MAX_RECEIPT_FILE_BYTES);
  }
}

function validReceiptKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096;
}

function validReceiptState(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !value.includes("\0");
}

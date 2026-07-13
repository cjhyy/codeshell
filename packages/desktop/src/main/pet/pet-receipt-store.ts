import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface ReceiptRecord {
  key: string;
  state: string;
  at: number;
}

export class PetReceiptStore {
  private readonly records = new Map<string, ReceiptRecord>();
  private writeQueue = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return;
      for (const item of parsed.slice(-1_000)) {
        const record = item as Partial<ReceiptRecord>;
        if (
          typeof record.key === "string" &&
          typeof record.state === "string" &&
          typeof record.at === "number"
        ) {
          this.records.set(record.key, record as ReceiptRecord);
        }
      }
    } catch {
      // Missing/corrupt receipt history means notifications may surface once again.
    }
  }

  has(key: string): boolean {
    return this.records.has(key);
  }

  mark(key: string, state = "seen"): void {
    this.records.set(key, { key, state, at: this.now() });
    while (this.records.size > 1_000) this.records.delete(this.records.keys().next().value!);
    this.writeQueue = this.writeQueue.then(() => this.persist()).catch(() => {});
  }

  flush(): Promise<void> {
    return this.writeQueue;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify([...this.records.values()], null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }
}

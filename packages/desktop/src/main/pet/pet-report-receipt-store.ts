import { dlog } from "../desktop-logger.js";
import {
  quarantineCorruptJson,
  readBoundedJson,
  writeOwnerJsonAtomic,
} from "./bounded-json-store.js";

interface PetReportReceipt {
  reportId: string;
  deliveredAt: number;
}

const MAX_RECEIPTS = 1_000;
const MAX_FILE_BYTES = 1024 * 1024;

export class PetReportReceiptStore {
  private receipts = new Map<string, PetReportReceipt>();
  private loadPromise: Promise<void> | undefined;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {}

  async has(reportId: string): Promise<boolean> {
    assertReportId(reportId);
    await this.load();
    return this.receipts.has(reportId);
  }

  mark(reportId: string): Promise<void> {
    assertReportId(reportId);
    const run = this.mutationQueue
      .catch(() => undefined)
      .then(() => this.load())
      .then(async () => {
        if (this.receipts.has(reportId)) return;
        const deliveredAt = this.now();
        if (!Number.isSafeInteger(deliveredAt) || deliveredAt < 0) {
          throw new Error("invalid Mimi report receipt timestamp");
        }
        const staged = new Map(this.receipts);
        staged.set(reportId, { reportId, deliveredAt });
        while (staged.size > MAX_RECEIPTS) staged.delete(staged.keys().next().value!);
        await writeOwnerJsonAtomic(this.filePath, [...staged.values()], MAX_FILE_BYTES);
        this.receipts = staged;
      });
    this.mutationQueue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<void> {
    if (!this.loadPromise) {
      const attempt = this.loadFromDisk().catch((error) => {
        // A transient quarantine/read failure must be retryable. Caching the
        // rejected promise would poison every report for the process lifetime.
        if (this.loadPromise === attempt) this.loadPromise = undefined;
        throw error;
      });
      this.loadPromise = attempt;
    }
    await this.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {
    let parsed: unknown | undefined;
    try {
      parsed = await readBoundedJson(this.filePath, MAX_FILE_BYTES);
    } catch (error) {
      const quarantinePath = await quarantineCorruptJson(this.filePath);
      dlog("main", "pet.report_receipts.quarantined", {
        file: this.filePath,
        quarantinePath,
        error: String(error),
      });
      await writeOwnerJsonAtomic(this.filePath, [], MAX_FILE_BYTES);
      return;
    }
    if (parsed === undefined) return;
    if (!Array.isArray(parsed)) {
      const quarantinePath = await quarantineCorruptJson(this.filePath);
      dlog("main", "pet.report_receipts.quarantined", {
        file: this.filePath,
        quarantinePath,
        error: "Mimi report receipt file is invalid",
      });
      await writeOwnerJsonAtomic(this.filePath, [], MAX_FILE_BYTES);
      return;
    }
    const valid = parsed.filter(isReceipt);
    if (valid.length !== parsed.length) {
      const quarantinePath = await quarantineCorruptJson(this.filePath);
      dlog("main", "pet.report_receipts.quarantined", {
        file: this.filePath,
        quarantinePath,
        invalidEntries: parsed.length - valid.length,
      });
      await writeOwnerJsonAtomic(this.filePath, valid.slice(-MAX_RECEIPTS), MAX_FILE_BYTES);
    }
    for (const receipt of valid.slice(-MAX_RECEIPTS)) {
      this.receipts.delete(receipt.reportId);
      this.receipts.set(receipt.reportId, receipt);
    }
  }
}

function assertReportId(reportId: string): void {
  if (!/^[a-f0-9]{32}$/u.test(reportId)) throw new Error("invalid Mimi report receipt id");
}

function isReceipt(value: unknown): value is PetReportReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<PetReportReceipt>;
  return (
    typeof receipt.reportId === "string" &&
    /^[a-f0-9]{32}$/u.test(receipt.reportId) &&
    Number.isSafeInteger(receipt.deliveredAt) &&
    (receipt.deliveredAt ?? -1) >= 0
  );
}

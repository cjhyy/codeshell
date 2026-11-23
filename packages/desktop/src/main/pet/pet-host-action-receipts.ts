/**
 * Durable receipts for Mimi's host actions, so a replayed turn does not repeat
 * its side effects.
 *
 * WHY THIS EXISTS
 * ---------------
 * Core defines `clientMessageId` as a stable submission-intent id: submitting the
 * same id twice does NOT re-run the model, it replays the persisted `run_result`
 * from the transcript. That layer is properly idempotent.
 *
 * The Desktop pet dispatcher, however, could not tell a fresh result from a
 * replayed one. It re-read `extensions.pet.hostActions` and ran every executor
 * again, so a duplicate delivery could repeat a follow-up mutation, send a second
 * proactive message, or repeat a memory/mobile side effect.
 *
 * Reachable in practice: the Chat Gateway derives a stable id from the upstream
 * message id, and its reply cache is only an in-process Map while the inbox is
 * durable. A restart between "Desktop finished" and "adapter acknowledged"
 * re-invokes Desktop with the same id — Engine replays, and the dispatcher used
 * to re-execute.
 *
 * The fix is a claim/complete log keyed by
 * `(petSessionId, clientMessageId, actionIndex)`:
 *   - claim before running an action; a claim that already has a stored result
 *     short-circuits and replays the receipt instead of the side effect;
 *   - store the outcome after it settles.
 *
 * Per-action keys matter: if action 1 completed and action 2 was never claimed,
 * the retry replays 1 and may start 2. If action 2 has a surviving claim, its
 * outcome is uncertain and it is deliberately not run again. In neither case
 * may the retry redo action 1.
 */

import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** What a completed host action recorded, enough to replay its reported outcome. */
export interface PetHostActionReceipt {
  kind: string;
  ok: boolean;
  /** A claimed action may have run; it must never be executed again blindly. */
  phase?: "claimed" | "completed";
  /** Mirrors PetHostActionExecution.result so a receipt replays as-is. */
  result?: Record<string, unknown>;
  error?: string;
  completedAt: number;
}

export type PetHostActionClaim =
  | { claimed: true }
  | { claimed: false; receipt: PetHostActionReceipt };

interface ReceiptFile {
  version: 1;
  entries: Record<string, PetHostActionReceipt>;
}

/** Cap the log so a long-lived install cannot grow it without bound. */
const MAX_RECEIPTS = 2_000;
const MAX_RECEIPT_FILE_ENTRIES = 10_000;
const MAX_RECEIPT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_RECEIPT_ID_LENGTH = 512;
const MAX_RECEIPT_ACTION_INDEX = 1_024;
const MAX_RECEIPT_KIND_LENGTH = 128;
const MAX_RECEIPT_ERROR_LENGTH = 8_000;

function isReceiptId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_RECEIPT_ID_LENGTH && !/[\u0000\r\n]/u.test(value);
}

function receiptKey(petSessionId: string, clientMessageId: string, actionIndex: number): string {
  if (
    !isReceiptId(petSessionId) ||
    !isReceiptId(clientMessageId) ||
    !Number.isSafeInteger(actionIndex) ||
    actionIndex < 0 ||
    actionIndex > MAX_RECEIPT_ACTION_INDEX
  ) {
    throw new Error("invalid Mimi host action receipt identity");
  }
  return `${petSessionId}\0${clientMessageId}\0${actionIndex}`;
}

export class PetHostActionReceiptStore {
  private entries = new Map<string, PetHostActionReceipt>();
  private loadPromise: Promise<void> | undefined;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly replaceFile?: (from: string, to: string) => Promise<void>,
  ) {}

  load(): Promise<void> {
    if (!this.loadPromise) {
      const attempt = this.doLoad();
      this.loadPromise = attempt;
      void attempt.catch(() => {
        if (this.loadPromise === attempt) this.loadPromise = undefined;
      });
    }
    return this.loadPromise;
  }

  private async doLoad(): Promise<void> {
    let raw: string;
    try {
      const info = await lstat(this.path);
      if (!info.isFile()) throw new Error("Mimi 主机操作幂等日志不是普通文件");
      if (info.size > MAX_RECEIPT_FILE_BYTES) {
        throw new Error("Mimi 主机操作幂等日志超过大小限制");
      }
      if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
        throw new Error("Mimi 主机操作幂等日志权限必须为 0600");
      }
      raw = await readFile(this.path, "utf-8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error("Mimi 主机操作幂等日志已损坏；为避免重复执行，已阻止操作", {
        cause: error,
      });
    }
    if (!isReceiptFile(parsed)) {
      throw new Error("Mimi 主机操作幂等日志格式无效；为避免重复执行，已阻止操作");
    }
    this.entries = new Map(Object.entries(parsed.entries));
  }

  /**
   * Receipt for an already-claimed action, or undefined if it was never claimed.
   *
   * A present receipt is the signal to SKIP the executor. Completed receipts
   * replay their recorded result; an incomplete claim reports uncertainty.
   */
  async find(
    petSessionId: string,
    clientMessageId: string,
    actionIndex: number,
  ): Promise<PetHostActionReceipt | undefined> {
    await this.load();
    return this.entries.get(receiptKey(petSessionId, clientMessageId, actionIndex));
  }

  /**
   * Atomically reserve one action before its external side effect starts.
   * A surviving claim means the previous process may already have performed
   * the action, so replay returns the uncertainty receipt instead of retrying.
   */
  async claim(
    petSessionId: string,
    clientMessageId: string,
    actionIndex: number,
    kind: string,
    startedAt = Date.now(),
  ): Promise<PetHostActionClaim> {
    const key = receiptKey(petSessionId, clientMessageId, actionIndex);
    if (
      !kind ||
      kind.length > MAX_RECEIPT_KIND_LENGTH ||
      /[\u0000-\u001f\u007f]/u.test(kind) ||
      !Number.isFinite(startedAt)
    ) {
      throw new Error("invalid Mimi host action receipt claim");
    }
    return await this.mutate((entries) => {
      const receipt = entries.get(key);
      if (receipt) return { claimed: false, receipt };
      entries.set(key, {
        kind,
        ok: false,
        phase: "claimed",
        error: "操作已开始但结果未记录；为避免重复执行，未自动重试。",
        completedAt: startedAt,
      });
      return { claimed: true };
    });
  }

  /** Persist an action's outcome so a later replay reuses it. */
  record(
    petSessionId: string,
    clientMessageId: string,
    actionIndex: number,
    receipt: PetHostActionReceipt,
  ): Promise<void> {
    if (!isReceipt(receipt)) {
      return Promise.reject(new Error("invalid Mimi host action receipt"));
    }
    return this.mutate((entries) => {
      entries.set(receiptKey(petSessionId, clientMessageId, actionIndex), {
        ...receipt,
        phase: "completed",
      });
      if (entries.size > MAX_RECEIPTS) {
        // A surviving claim means its external effect may already have run;
        // deleting it would permit an unsafe replay. Bound only completed
        // history and tolerate a larger file if many uncertain claims exist.
        const completed = [...entries.entries()]
          .filter(([, value]) => value.phase !== "claimed")
          .sort((left, right) => left[1].completedAt - right[1].completedAt);
        for (const [key] of completed.slice(0, entries.size - MAX_RECEIPTS)) {
          entries.delete(key);
        }
      }
    });
  }

  private mutate<T>(operation: (entries: Map<string, PetHostActionReceipt>) => T): Promise<T> {
    const run = this.mutationQueue
      .catch(() => undefined)
      .then(() => this.load())
      .then(async () => {
        const staged = new Map(this.entries);
        const result = operation(staged);
        await this.persist(staged);
        this.entries = staged;
        return result;
      });
    this.mutationQueue = run.catch(() => undefined);
    return run;
  }

  private async persist(entries: ReadonlyMap<string, PetHostActionReceipt>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const body: ReceiptFile = { version: 1, entries: Object.fromEntries(entries) };
    const serialized = `${JSON.stringify(body)}\n`;
    if (Buffer.byteLength(serialized, "utf-8") > MAX_RECEIPT_FILE_BYTES) {
      throw new Error("Mimi 主机操作幂等日志超过大小限制");
    }
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { encoding: "utf-8", mode: 0o600 });
      await (this.replaceFile ?? rename)(temporary, this.path);
      await chmod(this.path, 0o600).catch(() => undefined);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function isReceiptFile(value: unknown): value is ReceiptFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const file = value as Record<string, unknown>;
  if (
    file.version !== 1 ||
    !file.entries ||
    typeof file.entries !== "object" ||
    Array.isArray(file.entries)
  ) {
    return false;
  }
  const entries = Object.entries(file.entries as Record<string, unknown>);
  return (
    entries.length <= MAX_RECEIPT_FILE_ENTRIES &&
    entries.every(([key, candidate]) => {
      const parts = key.split("\0");
      if (parts.length !== 3 || !isReceiptId(parts[0]!) || !isReceiptId(parts[1]!)) return false;
      const actionIndex = Number(parts[2]);
      if (
        !/^\d{1,4}$/u.test(parts[2]!) ||
        !Number.isSafeInteger(actionIndex) ||
        actionIndex > MAX_RECEIPT_ACTION_INDEX
      ) {
        return false;
      }
      return isReceipt(candidate);
    })
  );
}

function isReceipt(value: unknown): value is PetHostActionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return (
    typeof receipt.kind === "string" &&
    receipt.kind.length > 0 &&
    receipt.kind.length <= MAX_RECEIPT_KIND_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(receipt.kind) &&
    typeof receipt.ok === "boolean" &&
    (receipt.phase === undefined || receipt.phase === "claimed" || receipt.phase === "completed") &&
    (receipt.result === undefined ||
      (Boolean(receipt.result) &&
        typeof receipt.result === "object" &&
        !Array.isArray(receipt.result))) &&
    (receipt.error === undefined ||
      (typeof receipt.error === "string" && receipt.error.length <= MAX_RECEIPT_ERROR_LENGTH)) &&
    typeof receipt.completedAt === "number" &&
    Number.isFinite(receipt.completedAt)
  );
}

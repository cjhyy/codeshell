import { dlog } from "./desktop-logger.js";
import {
  quarantineCorruptJson,
  readBoundedJson,
  writeOwnerJsonAtomic,
} from "./pet/bounded-json-store.js";

export interface DesktopNotificationInput {
  key: string;
  title: string;
  body: string;
  urgent?: boolean;
}

export type DesktopNotificationOutcome =
  | "shown"
  | "duplicate"
  | "focused"
  | "unsupported"
  | "failed";

interface DesktopNotificationReceipt {
  key: string;
  shownAt: number;
}

export interface DesktopNotifierDependencies {
  hasFocusedWindow(): boolean;
  isSupported(): boolean;
  show(input: { title: string; body: string }): void;
  now?(): number;
  sleep?(delayMs: number): Promise<void>;
  rateWindowMs?: number;
  maxNotificationsPerWindow?: number;
}

const MAX_RECEIPTS = 500;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_KEY_LENGTH = 4_096;
const MAX_TITLE_LENGTH = 512;
const MAX_BODY_LENGTH = 180;
const RATE_WINDOW_MS = 10_000;
const MAX_NOTIFICATIONS_PER_WINDOW = 5;

export class DesktopNotifier {
  private receipts = new Map<string, DesktopNotificationReceipt>();
  private loadPromise: Promise<void> | undefined;
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private notifyTimes: number[] = [];

  constructor(
    private readonly filePath: string,
    private readonly dependencies: DesktopNotifierDependencies,
  ) {}

  notify(input: DesktopNotificationInput): Promise<DesktopNotificationOutcome> {
    const run = this.mutationQueue
      .catch(() => undefined)
      .then(() => this.load())
      .then(() => this.notifyLoaded(input));
    this.mutationQueue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<void> {
    if (!this.loadPromise) {
      const attempt = this.loadFromDisk().catch((error) => {
        // Do not permanently poison this notifier on a transient filesystem
        // failure. A later delivery gets a fresh read/quarantine attempt.
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
      dlog("main", "desktop_notification.receipts_quarantined", {
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
      dlog("main", "desktop_notification.receipts_quarantined", {
        file: this.filePath,
        quarantinePath,
        error: "desktop notification receipt file is invalid",
      });
      await writeOwnerJsonAtomic(this.filePath, [], MAX_FILE_BYTES);
      return;
    }
    const valid = parsed.filter(isReceipt).slice(-MAX_RECEIPTS);
    if (valid.length !== parsed.length) {
      const quarantinePath = await quarantineCorruptJson(this.filePath);
      dlog("main", "desktop_notification.receipts_quarantined", {
        file: this.filePath,
        quarantinePath,
        invalidEntries: parsed.length - valid.length,
      });
      await writeOwnerJsonAtomic(this.filePath, valid, MAX_FILE_BYTES);
    }
    for (const candidate of valid) {
      this.receipts.delete(candidate.key);
      this.receipts.set(candidate.key, candidate);
    }
  }

  private async notifyLoaded(input: DesktopNotificationInput): Promise<DesktopNotificationOutcome> {
    if (!validKey(input.key)) throw new Error("desktop notification key is invalid");
    if (!validTitle(input.title)) throw new Error("desktop notification title is invalid");
    if (typeof input.body !== "string") throw new Error("desktop notification body is invalid");
    if (this.receipts.has(input.key)) return "duplicate";
    if (!input.urgent && this.dependencies.hasFocusedWindow()) return "focused";
    if (!this.dependencies.isSupported()) return "unsupported";

    // Urgent lifecycle failures bypass burst throttling. Ordinary completions
    // wait for a slot instead of silently dropping the sixth notification.
    const now = input.urgent ? this.now() : await this.waitForRateSlot();

    try {
      this.dependencies.show({
        title: input.title,
        body: Array.from(input.body.replace(/\s+/gu, " ").trim())
          .slice(0, MAX_BODY_LENGTH)
          .join(""),
      });
    } catch {
      return "failed";
    }

    // Only a successful show() call earns a durable receipt. Marking before
    // show made a synchronous Electron failure look like a delivered duplicate
    // on every replay.
    const staged = new Map(this.receipts);
    staged.set(input.key, { key: input.key, shownAt: now });
    while (staged.size > MAX_RECEIPTS) staged.delete(staged.keys().next().value!);
    // show() already succeeded, so keep the in-process receipt even if the
    // following disk commit fails. A retry in this process must not display a
    // second native notification; restart remains the unavoidable boundary of
    // a non-transactional OS side effect.
    this.receipts = staged;
    if (!input.urgent) this.notifyTimes.push(now);
    await writeOwnerJsonAtomic(this.filePath, [...staged.values()], MAX_FILE_BYTES);
    return "shown";
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }

  private async waitForRateSlot(): Promise<number> {
    const rateWindowMs = this.dependencies.rateWindowMs ?? RATE_WINDOW_MS;
    const maxNotifications =
      this.dependencies.maxNotificationsPerWindow ?? MAX_NOTIFICATIONS_PER_WINDOW;
    if (!Number.isFinite(rateWindowMs) || rateWindowMs <= 0) {
      throw new Error("desktop notification rate window must be positive");
    }
    if (!Number.isSafeInteger(maxNotifications) || maxNotifications <= 0) {
      throw new Error("desktop notification rate limit must be a positive integer");
    }

    for (;;) {
      const now = this.now();
      this.notifyTimes = this.notifyTimes.filter((shownAt) => now - shownAt < rateWindowMs);
      if (this.notifyTimes.length < maxNotifications) return now;
      const delayMs = Math.max(1, this.notifyTimes[0]! + rateWindowMs - now);
      await (this.dependencies.sleep?.(delayMs) ??
        new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
    }
  }
}

function validKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_KEY_LENGTH &&
    !/[\u0000\r\n]/u.test(value)
  );
}

function validTitle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_TITLE_LENGTH &&
    !value.includes("\0")
  );
}

function isReceipt(value: unknown): value is DesktopNotificationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<DesktopNotificationReceipt>;
  return (
    validKey(receipt.key) && Number.isSafeInteger(receipt.shownAt) && (receipt.shownAt ?? -1) >= 0
  );
}

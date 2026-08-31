import { readBoundedJson, writeOwnerJsonAtomic } from "./pet/bounded-json-store.js";

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
  | "rate-limited"
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
  private loadError: unknown;
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
      this.loadPromise = this.loadFromDisk().catch((error) => {
        this.loadError = error;
      });
    }
    await this.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {
    const parsed = await readBoundedJson(this.filePath, MAX_FILE_BYTES);
    if (parsed === undefined) return;
    if (!Array.isArray(parsed)) throw new Error("desktop notification receipt file is invalid");
    for (const candidate of parsed.slice(-MAX_RECEIPTS)) {
      if (!isReceipt(candidate)) throw new Error("desktop notification receipt is invalid");
      this.receipts.delete(candidate.key);
      this.receipts.set(candidate.key, candidate);
    }
  }

  private async notifyLoaded(input: DesktopNotificationInput): Promise<DesktopNotificationOutcome> {
    if (!validKey(input.key)) throw new Error("desktop notification key is invalid");
    if (!validTitle(input.title)) throw new Error("desktop notification title is invalid");
    if (typeof input.body !== "string") throw new Error("desktop notification body is invalid");
    if (this.loadError) return "failed";
    if (this.receipts.has(input.key)) return "duplicate";
    if (!input.urgent && this.dependencies.hasFocusedWindow()) return "focused";
    if (!this.dependencies.isSupported()) return "unsupported";

    const now = this.dependencies.now?.() ?? Date.now();
    const rateWindowMs = this.dependencies.rateWindowMs ?? RATE_WINDOW_MS;
    const maxNotifications =
      this.dependencies.maxNotificationsPerWindow ?? MAX_NOTIFICATIONS_PER_WINDOW;
    this.notifyTimes = this.notifyTimes.filter((shownAt) => now - shownAt < rateWindowMs);
    if (this.notifyTimes.length >= maxNotifications) return "rate-limited";

    const staged = new Map(this.receipts);
    staged.set(input.key, { key: input.key, shownAt: now });
    while (staged.size > MAX_RECEIPTS) staged.delete(staged.keys().next().value!);
    await writeOwnerJsonAtomic(this.filePath, [...staged.values()], MAX_FILE_BYTES);
    this.receipts = staged;
    this.notifyTimes.push(now);

    try {
      this.dependencies.show({
        title: input.title,
        body: Array.from(input.body.replace(/\s+/gu, " ").trim())
          .slice(0, MAX_BODY_LENGTH)
          .join(""),
      });
      return "shown";
    } catch {
      return "failed";
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

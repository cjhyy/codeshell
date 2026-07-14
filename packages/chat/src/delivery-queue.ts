import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChannelMessage } from "./channel.js";

export interface DeliveryQueueConfig {
  path?: string;
  maxPending: number;
  maxConcurrent: number;
  maxPerTarget: number;
  retryBaseMs: number;
  retryMaxMs: number;
  completedTtlMs: number;
}

interface DeliveryRecord {
  id: string;
  dedupeKey?: string;
  adapterId: string;
  message: ChannelMessage;
  attempts: number;
  nextAttemptAt: number;
  persistent: boolean;
}

interface DeliveryStateFile {
  version: 1;
  pending: Array<Omit<DeliveryRecord, "persistent">>;
  completed: Record<string, number>;
}

export interface DeliveryQueueStatus {
  pending: number;
  inFlight: number;
  delayed: number;
}

export class DeliveryBackpressureError extends Error {
  constructor(limit: number) {
    super(`Chat Gateway inbox 已满（上限 ${limit}）`);
    this.name = "DeliveryBackpressureError";
  }
}

/**
 * Thrown by the deliver callback when a record can never be routed (e.g. a
 * persisted message references an adapter that no longer exists after a config
 * change). The queue drops such records instead of retrying them forever.
 */
export class UnroutableDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnroutableDeliveryError";
  }
}

/**
 * Durable, bounded inbox. Text webhook deliveries are acknowledged only after
 * this queue has atomically recorded them; processing happens out of band with
 * per-target ordering and retry. Lazy attachment functions stay in-memory.
 */
export class DeliveryQueue {
  private readonly pending: DeliveryRecord[] = [];
  private readonly completed = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private readonly targetInFlight = new Map<string, number>();
  private mutation = Promise.resolve();
  private retryTimer?: ReturnType<typeof setTimeout>;
  private stopped = true;

  constructor(
    private readonly config: DeliveryQueueConfig,
    private readonly deliver: (adapterId: string, message: ChannelMessage) => Promise<void>,
    private readonly onError: (error: unknown, message: ChannelMessage) => void,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    if (this.config.path) await this.load();
    this.pump();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  status(): DeliveryQueueStatus {
    const now = Date.now();
    return {
      pending: this.pending.length,
      inFlight: this.inFlight.size,
      delayed: this.pending.filter((entry) => entry.nextAttemptAt > now).length,
    };
  }

  async enqueue(adapterId: string, message: ChannelMessage): Promise<"queued" | "duplicate"> {
    if (this.stopped) throw new Error("Chat Gateway inbox is stopped");
    const dedupeKey = deliveryDedupeKey(message);
    let result: "queued" | "duplicate" = "queued";
    await this.withMutation(async () => {
      this.pruneCompleted();
      if (
        dedupeKey &&
        (this.completed.has(dedupeKey) ||
          this.pending.some((entry) => entry.dedupeKey === dedupeKey))
      ) {
        result = "duplicate";
        return;
      }
      if (this.pending.length >= this.config.maxPending) {
        throw new DeliveryBackpressureError(this.config.maxPending);
      }
      const persistent = Boolean(this.config.path && !message.attachments?.length);
      const safeMessage = persistent ? serializableMessage(message) : message;
      this.pending.push({
        id: randomUUID(),
        ...(dedupeKey ? { dedupeKey } : {}),
        adapterId,
        message: safeMessage,
        attempts: 0,
        nextAttemptAt: Date.now(),
        persistent,
      });
      if (persistent) await this.persist();
    });
    this.pump();
    return result;
  }

  private pump(): void {
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const now = Date.now();
    while (this.inFlight.size < this.config.maxConcurrent) {
      const entry = this.pending.find((candidate) => {
        if (this.inFlight.has(candidate.id) || candidate.nextAttemptAt > now) return false;
        return (
          (this.targetInFlight.get(targetKey(candidate.message)) ?? 0) < this.config.maxPerTarget
        );
      });
      if (!entry) break;
      this.inFlight.add(entry.id);
      const key = targetKey(entry.message);
      this.targetInFlight.set(key, (this.targetInFlight.get(key) ?? 0) + 1);
      void this.process(entry);
    }
    const next = this.pending
      .filter((entry) => !this.inFlight.has(entry.id) && entry.nextAttemptAt > now)
      .reduce<
        number | undefined
      >((earliest, entry) => (earliest === undefined ? entry.nextAttemptAt : Math.min(earliest, entry.nextAttemptAt)), undefined);
    if (next !== undefined) {
      this.retryTimer = setTimeout(() => this.pump(), Math.max(1, next - Date.now()));
      this.retryTimer.unref?.();
    }
  }

  private async process(entry: DeliveryRecord): Promise<void> {
    let error: unknown;
    try {
      await this.deliver(entry.adapterId, entry.message);
    } catch (caught) {
      error = caught;
      this.onError(caught, entry.message);
    }

    await this.withMutation(async () => {
      this.inFlight.delete(entry.id);
      const key = targetKey(entry.message);
      const targetCount = (this.targetInFlight.get(key) ?? 1) - 1;
      if (targetCount <= 0) this.targetInFlight.delete(key);
      else this.targetInFlight.set(key, targetCount);

      if (error === undefined || error instanceof UnroutableDeliveryError) {
        // Success, or a permanently unroutable record: drop it so a message
        // that can never be delivered does not retry (and re-log) forever.
        const index = this.pending.findIndex((candidate) => candidate.id === entry.id);
        if (index >= 0) this.pending.splice(index, 1);
        if (error === undefined && entry.dedupeKey) this.completed.set(entry.dedupeKey, Date.now());
      } else {
        entry.attempts += 1;
        entry.nextAttemptAt =
          Date.now() +
          Math.min(
            this.config.retryMaxMs,
            this.config.retryBaseMs * 2 ** Math.min(entry.attempts - 1, 10),
          );
      }
      this.pruneCompleted();
      if (entry.persistent) await this.persist();
    });
    this.pump();
  }

  private async load(): Promise<void> {
    if (!this.config.path) return;
    try {
      const parsed = JSON.parse(await readFile(this.config.path, "utf-8")) as DeliveryStateFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.pending) || !parsed.completed) return;
      for (const entry of parsed.pending) {
        if (!validStoredEntry(entry)) continue;
        this.pending.push({ ...entry, persistent: true, nextAttemptAt: Date.now() });
      }
      for (const [key, timestamp] of Object.entries(parsed.completed)) {
        if (typeof timestamp === "number") this.completed.set(key, timestamp);
      }
      this.pruneCompleted();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`无法读取 Chat Gateway inbox：${String(error)}`, { cause: error });
      }
    }
  }

  private async persist(): Promise<void> {
    const path = this.config.path;
    if (!path) return;
    const state: DeliveryStateFile = {
      version: 1,
      pending: this.pending
        .filter((entry) => entry.persistent)
        .map(({ persistent: _persistent, ...entry }) => entry),
      completed: Object.fromEntries(this.completed),
    };
    const serialized = `${JSON.stringify(state)}\n`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { encoding: "utf-8", mode: 0o600 });
      await rename(temporary, path);
      await chmod(path, 0o600).catch(() => undefined);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private pruneCompleted(): void {
    const cutoff = Date.now() - this.config.completedTtlMs;
    for (const [key, timestamp] of this.completed) {
      if (timestamp < cutoff) this.completed.delete(key);
    }
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function deliveryDedupeKey(message: ChannelMessage): string | undefined {
  return message.messageId
    ? `${message.channel}\0${message.target}\0${message.senderId}\0${message.messageId}`
    : undefined;
}

function targetKey(message: ChannelMessage): string {
  return `${message.channel}\0${message.target}`;
}

function serializableMessage(message: ChannelMessage): ChannelMessage {
  const serialized = JSON.stringify(message);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf-8") > 1_048_576) {
    throw new Error("Chat Gateway message is not persistable or exceeds 1 MiB");
  }
  return JSON.parse(serialized) as ChannelMessage;
}

function validStoredEntry(entry: unknown): entry is Omit<DeliveryRecord, "persistent"> {
  if (!entry || typeof entry !== "object") return false;
  const value = entry as Partial<DeliveryRecord>;
  return (
    typeof value.id === "string" &&
    typeof value.adapterId === "string" &&
    typeof value.attempts === "number" &&
    typeof value.nextAttemptAt === "number" &&
    Boolean(value.message) &&
    typeof value.message?.channel === "string" &&
    typeof value.message?.target === "string" &&
    typeof value.message?.senderId === "string" &&
    typeof value.message?.text === "string" &&
    !value.message?.attachments
  );
}

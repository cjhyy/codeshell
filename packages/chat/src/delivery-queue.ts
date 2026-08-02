import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  /**
   * Directory for spooled attachment bytes. Defaults to `<path>.attachments`.
   *
   * Without a spool, a message carrying attachments could not be persisted (its
   * `load()` is a function), so it stayed in memory only — while the adapter had
   * ALREADY been told the message was accepted. Telegram advances its long-poll
   * offset and Slack acks on handler return, so a restart between enqueue and
   * delivery lost the message permanently: upstream will not resend, and the
   * durable inbox has no record.
   */
  attachmentSpoolDir?: string;
  /** Largest single attachment to spool. Bigger ones fall back to memory-only. */
  maxSpooledAttachmentBytes?: number;
}

/** Attachment metadata persisted in place of the un-serializable `load()`. */
interface SpooledAttachment {
  id: string;
  kind: string;
  name?: string;
  mimeType?: string;
  size: number;
  /** File under the spool dir holding the materialized bytes. */
  file: string;
}

interface DeliveryRecord {
  id: string;
  dedupeKey?: string;
  adapterId: string;
  message: ChannelMessage;
  attempts: number;
  nextAttemptAt: number;
  persistent: boolean;
  /** Spooled attachment metadata, present when bytes were written to disk. */
  spooled?: SpooledAttachment[];
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
    if (this.config.path) {
      await this.load();
      // Reclaim spool files no surviving record points at.
      await this.sweepOrphanedSpool();
    }
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
      const id = randomUUID();
      // Attachments used to make a record non-persistent outright, because
      // `load()` cannot be serialized — so the message lived in memory only while
      // the adapter had already acked it. Spool the bytes instead: the record
      // then persists like any other, carrying file paths in place of closures.
      const spooled = await this.spoolAttachments(id, message);
      const persistent = Boolean(
        this.config.path && (!message.attachments?.length || spooled !== undefined),
      );
      const safeMessage = persistent ? serializableMessage(message, spooled) : message;
      this.pending.push({
        id,
        ...(dedupeKey ? { dedupeKey } : {}),
        adapterId,
        message: safeMessage,
        attempts: 0,
        nextAttemptAt: Date.now(),
        persistent,
        ...(spooled ? { spooled } : {}),
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
        // Terminal outcome — the bytes will never be needed again. Cleaning up
        // here (rather than on a TTL sweep) keeps the spool bounded by what is
        // actually pending.
        await this.discardSpool(entry);
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

  /** Directory holding spooled attachment bytes, or undefined when not durable. */
  private spoolDir(): string | undefined {
    if (!this.config.path) return undefined;
    return this.config.attachmentSpoolDir ?? `${this.config.path}.attachments`;
  }

  /**
   * Materialize a message's attachments to disk so the record can be persisted.
   *
   * Returns undefined when there is nothing to spool, or when spooling fails —
   * in which case the caller falls back to the old memory-only behaviour rather
   * than dropping the message.
   */
  private async spoolAttachments(
    recordId: string,
    message: ChannelMessage,
  ): Promise<SpooledAttachment[] | undefined> {
    const attachments = message.attachments;
    const dir = this.spoolDir();
    if (!attachments?.length || !dir) return undefined;
    const limit = this.config.maxSpooledAttachmentBytes ?? 16 * 1024 * 1024;
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const spooled: SpooledAttachment[] = [];
      for (const [index, attachment] of attachments.entries()) {
        const bytes = await attachment.load();
        // Oversized payloads stay in memory: spooling them would trade a lost
        // message for unbounded disk use.
        if (bytes.byteLength > limit) return undefined;
        const file = `${recordId}.${index}`;
        await writeFile(`${dir}/${file}`, bytes, { mode: 0o600 });
        spooled.push({
          id: attachment.id,
          kind: attachment.kind,
          ...(attachment.name ? { name: attachment.name } : {}),
          ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
          size: bytes.byteLength,
          file,
        });
      }
      return spooled;
    } catch {
      // Spooling is an availability improvement, never a new failure mode.
      return undefined;
    }
  }

  /** Rebuild attachments whose bytes live in the spool. */
  private rehydrateAttachments(
    spooled: SpooledAttachment[] | undefined,
  ): ChannelMessage["attachments"] | undefined {
    const dir = this.spoolDir();
    if (!spooled?.length || !dir) return undefined;
    return spooled.map((entry) => ({
      id: entry.id,
      kind: entry.kind as never,
      ...(entry.name ? { name: entry.name } : {}),
      ...(entry.mimeType ? { mimeType: entry.mimeType } : {}),
      size: entry.size,
      load: async () => new Uint8Array(await readFile(`${dir}/${entry.file}`)),
    }));
  }

  /**
   * Delete spool files that no pending record references.
   *
   * `discardSpool` covers the normal path, but files can still be orphaned: a
   * crash between writing the bytes and persisting the record, or the
   * oversized-attachment fallback that spools nothing yet may have written
   * earlier attachments of the same message. Without this the directory only
   * grows, since nothing else ever looks at it.
   *
   * Runs once at load(), when the set of live records is exactly known.
   */
  private async sweepOrphanedSpool(): Promise<void> {
    const dir = this.spoolDir();
    if (!dir) return;
    const referenced = new Set<string>();
    for (const entry of this.pending) {
      for (const attachment of entry.spooled ?? []) referenced.add(attachment.file);
    }
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return; // No spool directory yet — nothing to sweep.
    }
    await Promise.all(
      files
        .filter((file) => !referenced.has(file))
        .map((file) => rm(`${dir}/${file}`, { force: true }).catch(() => undefined)),
    );
  }

  /** Delete a record's spooled files once it will never be delivered again. */
  private async discardSpool(entry: DeliveryRecord): Promise<void> {
    const dir = this.spoolDir();
    if (!entry.spooled?.length || !dir) return;
    await Promise.all(
      entry.spooled.map((attachment) =>
        rm(`${dir}/${attachment.file}`, { force: true }).catch(() => undefined),
      ),
    );
  }

  private async load(): Promise<void> {
    if (!this.config.path) return;
    try {
      const parsed = JSON.parse(await readFile(this.config.path, "utf-8")) as DeliveryStateFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.pending) || !parsed.completed) return;
      for (const entry of parsed.pending) {
        if (!validStoredEntry(entry)) continue;
        // Turn spooled metadata back into real attachments whose load() reads
        // the file. This is the whole point of the spool: after a restart the
        // upstream will not resend, so the bytes have to come from disk.
        const restored = this.rehydrateAttachments(entry.spooled);
        this.pending.push({
          ...entry,
          message: restored ? { ...entry.message, attachments: restored } : entry.message,
          persistent: true,
          nextAttemptAt: Date.now(),
        });
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
        .map(({ persistent: _persistent, ...entry }) => {
          // Never write live attachments: JSON drops their `load()`, leaving a
          // record that claims attachments it cannot produce — and whose
          // presence would stop the loader from rehydrating from the spool.
          // `entry.spooled` is the durable representation.
          if (!entry.message.attachments?.length) return entry;
          const { attachments: _attachments, ...message } = entry.message;
          return { ...entry, message };
        }),
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

function serializableMessage(
  message: ChannelMessage,
  spooled?: SpooledAttachment[],
): ChannelMessage {
  // Drop `attachments` before serializing: each carries a `load()` closure that
  // JSON silently discards, which would leave a persisted message claiming
  // attachments it can no longer produce. Spooled metadata is stored on the
  // RECORD instead, and rehydrated into real load() functions on restart.
  const { attachments: _attachments, ...rest } = message;
  const serialized = JSON.stringify(rest);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf-8") > 1_048_576) {
    throw new Error("Chat Gateway message is not persistable or exceeds 1 MiB");
  }
  const parsed = JSON.parse(serialized) as ChannelMessage;
  // Keep the live attachments for THIS process; the spool only matters after a
  // restart, and re-reading from disk while the originals are in hand is waste.
  if (message.attachments?.length && spooled) {
    return { ...parsed, attachments: message.attachments };
  }
  return parsed;
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

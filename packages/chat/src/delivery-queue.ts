import { randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
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

const MAX_DELIVERY_STATE_BYTES = 64 * 1024 * 1024;
const MAX_COMPLETED_KEYS = 100_000;
const MAX_SPOOLED_ATTACHMENTS = 32;
const MAX_SPOOL_SCAN_ENTRIES = 100_000;
const SPOOL_FILE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.\d{1,3}$/iu;

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
  /** Enqueues that reserved capacity while attachments are materialized outside the mutation lock. */
  private readonly preparing = new Map<string, string | undefined>();
  private readonly completed = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private readonly targetInFlight = new Map<string, number>();
  private mutation = Promise.resolve();
  private retryTimer?: ReturnType<typeof setTimeout>;
  private persistRetryTimer?: ReturnType<typeof setTimeout>;
  /** Terminal records whose spool may be deleted after a successful state retry. */
  private readonly persistRetryCleanups = new Map<
    string,
    { entry: DeliveryRecord; message: ChannelMessage }
  >();
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
    if (this.persistRetryTimer) clearTimeout(this.persistRetryTimer);
    this.persistRetryTimer = undefined;
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
    const id = randomUUID();
    const reserved = await this.withMutation(async () => {
      if (this.stopped) throw new Error("Chat Gateway inbox is stopped");
      this.pruneCompleted();
      if (
        dedupeKey &&
        (this.completed.has(dedupeKey) ||
          this.pending.some((entry) => entry.dedupeKey === dedupeKey) ||
          [...this.preparing.values()].some((candidate) => candidate === dedupeKey))
      ) {
        return false;
      }
      if (this.pending.length + this.preparing.size >= this.config.maxPending) {
        throw new DeliveryBackpressureError(this.config.maxPending);
      }
      this.preparing.set(id, dedupeKey);
      return true;
    });
    if (!reserved) return "duplicate";

    // attachment.load() may perform an unbounded network read. The reservation
    // above preserves dedupe/backpressure, while doing the I/O here prevents one
    // slow attachment from blocking every enqueue and terminal state write.
    const spooled = await this.spoolAttachments(id, message);
    let record: DeliveryRecord | undefined;
    try {
      await this.withMutation(async () => {
        try {
          if (this.stopped) throw new Error("Chat Gateway inbox is stopped");
          const persistent = Boolean(
            this.config.path && (!message.attachments?.length || spooled !== undefined),
          );
          const safeMessage = persistent ? serializableMessage(message, spooled) : message;
          record = {
            id,
            ...(dedupeKey ? { dedupeKey } : {}),
            adapterId,
            message: safeMessage,
            attempts: 0,
            nextAttemptAt: Date.now(),
            persistent,
            ...(spooled ? { spooled } : {}),
          };
          this.pending.push(record);
          if (persistent) await this.persist();
        } catch (error) {
          if (record) {
            const index = this.pending.findIndex((candidate) => candidate.id === record?.id);
            if (index >= 0) this.pending.splice(index, 1);
          }
          throw error;
        } finally {
          this.preparing.delete(id);
        }
      });
    } catch (error) {
      await this.discardSpool(
        record ?? {
          id,
          adapterId,
          message,
          attempts: 0,
          nextAttemptAt: 0,
          persistent: false,
          ...(spooled ? { spooled } : {}),
        },
      );
      throw error;
    }
    this.pump();
    return "queued";
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

    const terminal = error === undefined || error instanceof UnroutableDeliveryError;
    try {
      await this.withMutation(async () => {
        this.inFlight.delete(entry.id);
        const key = targetKey(entry.message);
        const targetCount = (this.targetInFlight.get(key) ?? 1) - 1;
        if (targetCount <= 0) this.targetInFlight.delete(key);
        else this.targetInFlight.set(key, targetCount);

        if (terminal) {
          // Success, or a permanently unroutable record: drop it so a message
          // that can never be delivered does not retry (and re-log) forever.
          const index = this.pending.findIndex((candidate) => candidate.id === entry.id);
          if (index >= 0) this.pending.splice(index, 1);
          if (error === undefined && entry.dedupeKey)
            this.completed.set(entry.dedupeKey, Date.now());
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
        // Persist the terminal removal BEFORE deleting attachment bytes. If the
        // state write fails, the durable record still has everything needed for
        // at-least-once recovery after a crash.
        if (entry.persistent) await this.persist();
        if (terminal) await this.discardSpool(entry);
      });
    } catch (persistError) {
      this.onError(persistError, entry.message);
      this.schedulePersistRetry(entry.message, terminal ? entry : undefined);
    }
    this.pump();
  }

  private schedulePersistRetry(message: ChannelMessage, cleanup?: DeliveryRecord): void {
    if (cleanup) this.persistRetryCleanups.set(cleanup.id, { entry: cleanup, message });
    if (this.stopped || !this.config.path || this.persistRetryTimer) return;
    const delay = Math.max(10, Math.min(this.config.retryBaseMs, this.config.retryMaxMs));
    this.persistRetryTimer = setTimeout(() => {
      this.persistRetryTimer = undefined;
      if (this.stopped) return;
      void this.withMutation(async () => {
        await this.persist();
        for (const [id, pendingCleanup] of this.persistRetryCleanups) {
          await this.discardSpool(pendingCleanup.entry);
          this.persistRetryCleanups.delete(id);
        }
      }).catch((error) => {
        const relatedMessage = this.persistRetryCleanups.values().next().value?.message ?? message;
        this.onError(error, relatedMessage);
        this.schedulePersistRetry(relatedMessage);
      });
    }, delay);
    this.persistRetryTimer.unref?.();
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
    const written: string[] = [];
    try {
      if (attachments.length > MAX_SPOOLED_ATTACHMENTS) return undefined;
      await ensureRealDirectory(dir);
      const spooled: SpooledAttachment[] = [];
      for (const [index, attachment] of attachments.entries()) {
        const bytes = await attachment.load();
        // Oversized payloads stay in memory: spooling them would trade a lost
        // message for unbounded disk use.
        if (bytes.byteLength > limit) throw new Error("attachment exceeds spool limit");
        const file = `${recordId}.${index}`;
        const target = `${dir}/${file}`;
        await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
        written.push(target);
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
      await Promise.all(
        written.map((target) => rm(target, { force: true }).catch(() => undefined)),
      );
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
      load: async () =>
        new Uint8Array(
          await readBoundedSpoolFile(
            dir,
            entry.file,
            entry.size,
            this.config.maxSpooledAttachmentBytes ?? 16 * 1024 * 1024,
          ),
        ),
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
    let files: Dirent[];
    try {
      await assertRealDirectory(dir);
      files = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return; // No spool directory yet — nothing to sweep.
    }
    if (files.length > MAX_SPOOL_SCAN_ENTRIES) {
      throw new Error("Chat Gateway attachment spool has too many entries");
    }
    await Promise.all(
      files
        .filter(
          (entry) =>
            entry.isFile() && SPOOL_FILE_RE.test(entry.name) && !referenced.has(entry.name),
        )
        .map((entry) => rm(`${dir}/${entry.name}`, { force: true }).catch(() => undefined)),
    );
  }

  /** Delete a record's spooled files once it will never be delivered again. */
  private async discardSpool(entry: DeliveryRecord): Promise<void> {
    const dir = this.spoolDir();
    if (!entry.spooled?.length || !dir) return;
    try {
      await assertRealDirectory(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await Promise.all(
      entry.spooled
        .filter((attachment) => SPOOL_FILE_RE.test(attachment.file))
        .map(async (attachment) => {
          const target = `${dir}/${attachment.file}`;
          try {
            const info = await lstat(target);
            if (!info.isSymbolicLink() && info.isFile()) await rm(target, { force: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }),
    );
  }

  private async load(): Promise<void> {
    if (!this.config.path) return;
    try {
      const parsed = JSON.parse(
        await readBoundedRegularFile(
          this.config.path,
          MAX_DELIVERY_STATE_BYTES,
          "Chat Gateway inbox",
        ),
      ) as DeliveryStateFile;
      if (
        parsed.version !== 1 ||
        !Array.isArray(parsed.pending) ||
        parsed.pending.length > this.config.maxPending ||
        !parsed.completed ||
        typeof parsed.completed !== "object" ||
        Array.isArray(parsed.completed)
      ) {
        throw new Error("invalid delivery state root");
      }
      for (const entry of parsed.pending) {
        if (!validStoredEntry(entry, this.config.maxSpooledAttachmentBytes ?? 16 * 1024 * 1024)) {
          continue;
        }
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
      const completed = Object.entries(parsed.completed);
      if (completed.length > MAX_COMPLETED_KEYS) throw new Error("too many completed deliveries");
      for (const [key, timestamp] of completed) {
        if (
          key.length <= 16_384 &&
          typeof timestamp === "number" &&
          Number.isSafeInteger(timestamp) &&
          timestamp >= 0
        ) {
          this.completed.set(key, timestamp);
        }
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
    if (Buffer.byteLength(serialized, "utf8") > MAX_DELIVERY_STATE_BYTES) {
      throw new DeliveryBackpressureError(this.config.maxPending);
    }
    const parent = dirname(path);
    await ensureRealDirectory(parent);
    await assertSafeRegularTarget(path);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { encoding: "utf-8", mode: 0o600, flag: "wx" });
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

function validStoredEntry(
  entry: unknown,
  maxAttachmentBytes: number,
): entry is Omit<DeliveryRecord, "persistent"> {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const value = entry as Partial<DeliveryRecord>;
  if (
    typeof value.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.id) ||
    typeof value.adapterId !== "string" ||
    value.adapterId.length === 0 ||
    value.adapterId.length > 256 ||
    !Number.isSafeInteger(value.attempts) ||
    (value.attempts ?? -1) < 0 ||
    (value.attempts ?? 0) > 10_000 ||
    !Number.isSafeInteger(value.nextAttemptAt) ||
    (value.nextAttemptAt ?? -1) < 0 ||
    !value.message ||
    typeof value.message !== "object" ||
    typeof value.message.channel !== "string" ||
    value.message.channel.length === 0 ||
    value.message.channel.length > 64 ||
    typeof value.message.target !== "string" ||
    value.message.target.length === 0 ||
    value.message.target.length > 4_096 ||
    typeof value.message.senderId !== "string" ||
    value.message.senderId.length === 0 ||
    value.message.senderId.length > 4_096 ||
    typeof value.message.text !== "string" ||
    value.message.text.length > 1_048_576 ||
    value.message.attachments
  ) {
    return false;
  }
  if (
    value.dedupeKey !== undefined &&
    (typeof value.dedupeKey !== "string" || value.dedupeKey.length > 16_384)
  ) {
    return false;
  }
  if (value.spooled === undefined) return true;
  if (!Array.isArray(value.spooled) || value.spooled.length > MAX_SPOOLED_ATTACHMENTS) return false;
  const files = new Set<string>();
  for (const attachment of value.spooled) {
    if (
      !attachment ||
      typeof attachment !== "object" ||
      typeof attachment.id !== "string" ||
      attachment.id.length === 0 ||
      attachment.id.length > 4_096 ||
      typeof attachment.kind !== "string" ||
      attachment.kind.length === 0 ||
      attachment.kind.length > 64 ||
      (attachment.name !== undefined &&
        (typeof attachment.name !== "string" || attachment.name.length > 4_096)) ||
      (attachment.mimeType !== undefined &&
        (typeof attachment.mimeType !== "string" || attachment.mimeType.length > 1_024)) ||
      !Number.isSafeInteger(attachment.size) ||
      attachment.size < 0 ||
      attachment.size > maxAttachmentBytes ||
      typeof attachment.file !== "string" ||
      !SPOOL_FILE_RE.test(attachment.file) ||
      !attachment.file.startsWith(`${value.id}.`) ||
      files.has(attachment.file)
    ) {
      return false;
    }
    files.add(attachment.file);
  }
  return true;
}

async function ensureRealDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertRealDirectory(path);
}

async function assertRealDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Chat Gateway storage path is not a real directory: ${path}`);
  }
}

async function assertSafeRegularTarget(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Chat Gateway storage target is not a regular file: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function readBoundedRegularFile(
  path: string,
  maxBytes: number,
  label: string,
): Promise<string> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size > maxBytes) {
    throw new Error(`${label} is not a bounded regular file`);
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) {
      throw new Error(`${label} is not a bounded regular file`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function readBoundedSpoolFile(
  dir: string,
  file: string,
  expectedBytes: number,
  maxBytes: number,
): Promise<Buffer> {
  if (!SPOOL_FILE_RE.test(file) || expectedBytes < 0 || expectedBytes > maxBytes) {
    throw new Error("invalid Chat Gateway attachment spool reference");
  }
  await assertRealDirectory(dir);
  const target = `${dir}/${file}`;
  const entry = await lstat(target);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size !== expectedBytes) {
    throw new Error("Chat Gateway attachment spool file is invalid");
  }
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== expectedBytes || opened.size > maxBytes) {
      throw new Error("Chat Gateway attachment spool file is invalid");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

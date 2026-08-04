import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const EVENT_KEY_PATTERN = /^[a-f0-9]{32}:\d{1,16}$/u;
const TARGET_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_PROGRESS_EVENTS = 200;
const MAX_PROGRESS_TARGETS = 32;
const MAX_TOTAL_PROGRESS_TARGETS = MAX_PROGRESS_EVENTS * MAX_PROGRESS_TARGETS * 2;
const MAX_CHUNKS_PER_TARGET = 10_000;
const MAX_PROGRESS_FILE_BYTES = 2 * 1024 * 1024;

export interface NotificationEventDeliveryProgressState {
  chunks: Record<string, number>;
  /** Number of attachment descriptors accepted for each opaque target. */
  attachments: Record<string, number>;
}

export interface NotificationDeliveryProgressState {
  version: 3;
  events: Record<string, NotificationEventDeliveryProgressState>;
}

export interface NotificationDeliveryProgressStore {
  load(): Promise<NotificationDeliveryProgressState | undefined>;
  save(state: NotificationDeliveryProgressState): Promise<void>;
}

/** Keep transport progress next to, but independent from, the Desktop event cursor. */
export function notificationDeliveryProgressPath(eventCursorPath: string): string {
  return `${eventCursorPath}.deliveries`;
}

/** Opaque key: the progress file never needs to disclose a raw owner destination. */
export function notificationTargetProgressKey(channel: string, target: string): string {
  return createHash("sha256").update(channel).update("\0").update(target).digest("base64url");
}

/** Owner-only, atomic persistence for partially delivered notification events. */
export class FileNotificationDeliveryProgressStore implements NotificationDeliveryProgressStore {
  constructor(readonly path: string) {}

  async load(): Promise<NotificationDeliveryProgressState | undefined> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      // Inspect before reading: the size bound must prevent the allocation, not
      // merely reject it afterwards. lstat also rejects a symlink that could
      // substitute attacker-controlled "already delivered" markers.
      const info = await lstat(this.path);
      if (!info.isFile()) throw new Error(`Notification progress is not a file: ${this.path}`);
      if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
        throw new Error(`Notification progress permissions must be 0600: ${this.path}`);
      }
      if (info.size > MAX_PROGRESS_FILE_BYTES) {
        throw new Error(`Notification progress is too large: ${this.path}`);
      }
      const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
      handle = await open(this.path, constants.O_RDONLY | noFollow);
      const openedInfo = await handle.stat();
      if (!openedInfo.isFile() || openedInfo.size > MAX_PROGRESS_FILE_BYTES) {
        throw new Error(`Notification progress is not a bounded regular file: ${this.path}`);
      }
      const raw = await handle.readFile("utf-8");
      if (Buffer.byteLength(raw, "utf-8") > MAX_PROGRESS_FILE_BYTES) {
        throw new Error(`Notification progress is too large: ${this.path}`);
      }
      return parseNotificationDeliveryProgress(raw, this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async save(state: NotificationDeliveryProgressState): Promise<void> {
    const validated = parseNotificationDeliveryProgress(JSON.stringify(state), this.path);
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const parentInfo = await lstat(parent);
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
      throw new Error(`Notification progress parent is not a regular directory: ${parent}`);
    }
    await chmod(parent, 0o700).catch(() => undefined);
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(validated)}\n`, {
        encoding: "utf-8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, this.path);
      await chmod(this.path, 0o600).catch(() => undefined);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

/**
 * Serializes progress mutations made by targets delivering in parallel. A
 * successful transport call is recorded before the event handler returns, so
 * a later target failure or ordinary process restart resumes at the owed part.
 */
export class NotificationDeliveryProgress {
  private state?: NotificationDeliveryProgressState;
  private loadTask?: Promise<void>;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly store?: NotificationDeliveryProgressStore) {}

  async begin(eventKey: string): Promise<void> {
    if (!EVENT_KEY_PATTERN.test(eventKey)) throw new Error("Invalid notification event key");
    await this.ensureLoaded();
    const operation = this.writeTail
      .catch(() => undefined)
      .then(async () => {
        const state = this.state ?? { version: 3 as const, events: {} };
        this.state = state;
        if (state.events[eventKey]) return;
        state.events[eventKey] = { chunks: {}, attachments: {} };
        while (Object.keys(state.events).length > MAX_PROGRESS_EVENTS) {
          const oldest = Object.keys(state.events)[0];
          if (!oldest) break;
          delete state.events[oldest];
        }
        await this.persistCurrent();
      });
    this.writeTail = operation;
    await operation;
  }

  chunkIndex(eventKey: string, targetKey: string): number {
    return this.requireEventState(eventKey).chunks[targetKey] ?? 0;
  }

  attachmentIndex(eventKey: string, targetKey: string): number {
    return this.requireEventState(eventKey).attachments[targetKey] ?? 0;
  }

  async mark(
    eventKey: string,
    targetKey: string,
    chunkIndex: number,
    attachmentIndex?: number,
  ): Promise<void> {
    if (!EVENT_KEY_PATTERN.test(eventKey)) throw new Error("Invalid notification event key");
    if (!TARGET_KEY_PATTERN.test(targetKey)) throw new Error("Invalid notification target key");
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > MAX_CHUNKS_PER_TARGET) {
      throw new Error("Invalid notification chunk progress");
    }
    if (
      attachmentIndex !== undefined &&
      (!Number.isSafeInteger(attachmentIndex) || attachmentIndex < 0 || attachmentIndex > 4)
    ) {
      throw new Error("Invalid notification attachment progress");
    }
    const operation = this.writeTail
      .catch(() => undefined)
      .then(async () => {
        const eventState = this.requireEventState(eventKey);
        eventState.chunks[targetKey] = Math.max(eventState.chunks[targetKey] ?? 0, chunkIndex);
        if (attachmentIndex !== undefined) {
          eventState.attachments[targetKey] = Math.max(
            eventState.attachments[targetKey] ?? 0,
            attachmentIndex,
          );
        }
        const state = this.requireState();
        validateProgressShape(state, "memory");
        await this.store?.save(cloneProgress(state));
      });
    this.writeTail = operation;
    await operation;
  }

  /** Retry a previously failed state write before the outer event is acknowledged. */
  async flush(): Promise<void> {
    const operation = this.writeTail.catch(() => undefined).then(() => this.persistCurrent());
    this.writeTail = operation;
    await operation;
  }

  private ensureLoaded(): Promise<void> {
    this.loadTask ??= (async () => {
      const loaded = await this.store?.load();
      this.state = loaded ? cloneProgress(loaded) : undefined;
    })();
    return this.loadTask;
  }

  private async persistCurrent(): Promise<void> {
    const state = this.requireState();
    validateProgressShape(state, "memory");
    await this.store?.save(cloneProgress(state));
  }

  private requireState(): NotificationDeliveryProgressState {
    if (!this.state) throw new Error("Notification progress has not started");
    return this.state;
  }

  private requireEventState(eventKey: string): NotificationEventDeliveryProgressState {
    const state = this.requireState();
    const eventState = state.events[eventKey];
    if (!eventState) throw new Error("Notification event progress has not started");
    return eventState;
  }
}

function parseNotificationDeliveryProgress(
  raw: string,
  source: string,
): NotificationDeliveryProgressState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid notification progress JSON: ${source}`, { cause: error });
  }
  const migrated = migrateLegacyProgress(parsed, source);
  validateProgressShape(migrated, source);
  return cloneProgress(migrated);
}

function validateProgressShape(
  value: unknown,
  source: string,
): asserts value is NotificationDeliveryProgressState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid notification progress: ${source}`);
  }
  const candidate = value as Partial<NotificationDeliveryProgressState>;
  if (
    candidate.version !== 3 ||
    !candidate.events ||
    typeof candidate.events !== "object" ||
    Array.isArray(candidate.events)
  ) {
    throw new Error(`Invalid notification progress: ${source}`);
  }
  const events = Object.entries(candidate.events);
  if (
    events.length > MAX_PROGRESS_EVENTS ||
    events.some(
      ([eventKey, eventState]) =>
        !EVENT_KEY_PATTERN.test(eventKey) || !isValidEventProgress(eventState),
    ) ||
    events.reduce(
      (total, [, eventState]) =>
        total + Object.keys(eventState.chunks).length + Object.keys(eventState.attachments).length,
      0,
    ) > MAX_TOTAL_PROGRESS_TARGETS
  ) {
    throw new Error(`Invalid notification progress: ${source}`);
  }
}

function isValidEventProgress(value: unknown): value is NotificationEventDeliveryProgressState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<NotificationEventDeliveryProgressState>;
  if (
    !candidate.chunks ||
    typeof candidate.chunks !== "object" ||
    Array.isArray(candidate.chunks) ||
    !candidate.attachments ||
    typeof candidate.attachments !== "object" ||
    Array.isArray(candidate.attachments)
  ) {
    return false;
  }
  const chunks = Object.entries(candidate.chunks);
  const attachments = Object.entries(candidate.attachments);
  return (
    chunks.length <= MAX_PROGRESS_TARGETS &&
    chunks.every(
      ([key, count]) =>
        TARGET_KEY_PATTERN.test(key) &&
        Number.isSafeInteger(count) &&
        count >= 0 &&
        count <= MAX_CHUNKS_PER_TARGET,
    ) &&
    attachments.length <= MAX_PROGRESS_TARGETS &&
    attachments.every(
      ([key, count]) =>
        TARGET_KEY_PATTERN.test(key) && Number.isSafeInteger(count) && count >= 0 && count <= 4,
    )
  );
}

function migrateLegacyProgress(value: unknown, source: string): NotificationDeliveryProgressState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid notification progress: ${source}`);
  }
  const legacy = value as {
    version?: unknown;
    eventKey?: unknown;
    chunks?: unknown;
    attachments?: unknown;
    events?: unknown;
  };
  if (legacy.version === 2) {
    if (!legacy.events || typeof legacy.events !== "object" || Array.isArray(legacy.events)) {
      throw new Error(`Invalid notification progress: ${source}`);
    }
    const events = Object.fromEntries(
      Object.entries(legacy.events).map(([eventKey, rawEvent]) => {
        if (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent)) {
          throw new Error(`Invalid notification progress: ${source}`);
        }
        const event = rawEvent as { chunks?: unknown; attachments?: unknown };
        if (!Array.isArray(event.attachments)) {
          throw new Error(`Invalid notification progress: ${source}`);
        }
        return [
          eventKey,
          {
            chunks: event.chunks,
            // v2 recorded only an all-attachments boolean. Four is the
            // protocol maximum, so every possible descriptor remains skipped.
            attachments: Object.fromEntries(event.attachments.map((key) => [key, 4])),
          },
        ];
      }),
    );
    return { version: 3, events } as NotificationDeliveryProgressState;
  }
  if (legacy.version !== 1) return value as NotificationDeliveryProgressState;
  if (
    typeof legacy.eventKey !== "string" ||
    !EVENT_KEY_PATTERN.test(legacy.eventKey) ||
    !legacy.chunks ||
    typeof legacy.chunks !== "object" ||
    Array.isArray(legacy.chunks) ||
    !Array.isArray(legacy.attachments)
  ) {
    throw new Error(`Invalid notification progress: ${source}`);
  }
  return {
    version: 3,
    events: {
      [legacy.eventKey]: {
        chunks: { ...(legacy.chunks as Record<string, number>) },
        attachments: Object.fromEntries((legacy.attachments as string[]).map((key) => [key, 4])),
      },
    },
  };
}

function cloneProgress(
  state: NotificationDeliveryProgressState,
): NotificationDeliveryProgressState {
  return {
    version: 3,
    events: Object.fromEntries(
      Object.entries(state.events).map(([eventKey, eventState]) => [
        eventKey,
        {
          chunks: { ...eventState.chunks },
          attachments: { ...eventState.attachments },
        },
      ]),
    ),
  };
}

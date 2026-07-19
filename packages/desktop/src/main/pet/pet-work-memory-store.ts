import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PetTopicSegment, PetWorkMemoryEntry } from "@cjhyy/code-shell-pet";

const MAX_ENTRIES = 1_000;
const MAX_SEGMENTS = 50;

interface PersistedWorkMemory {
  version: 1;
  lastInteractionAt: number;
  /** Legacy single active segment (pre-boundary-history). Still read on load. */
  activeSegment?: PetTopicSegment;
  /** Topic-segment boundary history, oldest → newest (the last is active). */
  segments?: PetTopicSegment[];
  entries: PetWorkMemoryEntry[];
}

/** One message-keyed boundary surfaced to the Mimi chat UI. */
export interface PetSegmentBoundary {
  boundaryBeforeMessageId: string;
  brief?: string;
}

function isEntry(value: unknown): value is PetWorkMemoryEntry {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.segmentId === "string" &&
    typeof record.objective === "string" &&
    (record.outcome === "completed" ||
      record.outcome === "pending-decided" ||
      record.outcome === "failed") &&
    (record.dedupeKey === undefined || typeof record.dedupeKey === "string") &&
    typeof record.at === "number"
  );
}

function isSegment(value: unknown): value is PetTopicSegment {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.startedAt === "number";
}

/**
 * Durable per-segment work memory for the Mimi main conversation.
 *
 * Stores the distilled work-memory entries (one per closed delegation), the
 * topic-segment boundary history (each keyed by the client message id of the
 * segment's first chat turn), and the last-interaction timestamp used to detect
 * long-idle segment boundaries. Writes go through an atomic temp-file + rename
 * (same discipline as PetReceiptStore); reads tolerate a missing or corrupt
 * file by starting empty.
 */
export class PetWorkMemoryStore {
  private entriesList: PetWorkMemoryEntry[] = [];
  private segments: PetTopicSegment[] = [];
  private last = 0;
  private writeQueue = Promise.resolve();
  private mutationQueue = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(
        await readFile(this.filePath, "utf8"),
      ) as Partial<PersistedWorkMemory>;
      if (Array.isArray(parsed.entries)) {
        this.entriesList = parsed.entries.filter(isEntry).slice(-MAX_ENTRIES);
      }
      if (typeof parsed.lastInteractionAt === "number") {
        this.last = parsed.lastInteractionAt;
      }
      if (Array.isArray(parsed.segments)) {
        this.segments = parsed.segments.filter(isSegment).slice(-MAX_SEGMENTS);
      } else if (isSegment(parsed.activeSegment)) {
        // Migrate a legacy single active segment into the boundary history.
        this.segments = [parsed.activeSegment];
      }
    } catch {
      // Missing/corrupt work memory means continuity resets to empty — never fatal.
    }
  }

  entries(): PetWorkMemoryEntry[] {
    return this.entriesList;
  }

  activeSegment(): PetTopicSegment | undefined {
    return this.segments.at(-1);
  }

  /**
   * Message-keyed topic-segment boundaries surfaced to the Mimi chat UI, oldest
   * → newest. Only segments that captured a chat message id appear here; a
   * legacy/time-only segment (no `boundaryBeforeMessageId`) renders no boundary.
   */
  segmentBoundaries(): PetSegmentBoundary[] {
    return this.segments
      .filter((segment) => typeof segment.boundaryBeforeMessageId === "string")
      .map((segment) => ({
        boundaryBeforeMessageId: segment.boundaryBeforeMessageId!,
        ...(segment.brief ? { brief: segment.brief } : {}),
      }));
  }

  lastInteractionAt(): number {
    return this.last;
  }

  async append(entry: PetWorkMemoryEntry): Promise<void> {
    return this.enqueueMutation(async () => {
      if (
        entry.dedupeKey &&
        this.entriesList.some((existing) => existing.dedupeKey === entry.dedupeKey)
      ) {
        return;
      }
      const previous = this.entriesList;
      this.entriesList = [...this.entriesList, entry].slice(-MAX_ENTRIES);
      try {
        await this.enqueuePersist();
      } catch (error) {
        this.entriesList = previous;
        throw error;
      }
    });
  }

  /**
   * Open a new topic segment, appending it to the boundary history (capped at
   * MAX_SEGMENTS, most recent kept). The newest segment is the active one.
   */
  async openSegment(segment: PetTopicSegment): Promise<void> {
    return this.enqueueMutation(async () => {
      const previous = this.segments;
      this.segments = [...this.segments, segment].slice(-MAX_SEGMENTS);
      try {
        await this.enqueuePersist();
      } catch (error) {
        this.segments = previous;
        throw error;
      }
    });
  }

  async setLastInteractionAt(at: number): Promise<void> {
    return this.enqueueMutation(async () => {
      const previous = this.last;
      this.last = at;
      try {
        await this.enqueuePersist();
      } catch (error) {
        this.last = previous;
        throw error;
      }
    });
  }

  flush(): Promise<void> {
    return Promise.all([this.mutationQueue, this.writeQueue]).then(() => undefined);
  }

  private enqueueMutation(operation: () => Promise<void>): Promise<void> {
    const pending = this.mutationQueue.then(operation);
    this.mutationQueue = pending.catch(() => undefined);
    return pending;
  }

  private enqueuePersist(): Promise<void> {
    const snapshot: PersistedWorkMemory = {
      version: 1,
      lastInteractionAt: this.last,
      ...(this.segments.length > 0 ? { segments: [...this.segments] } : {}),
      entries: [...this.entriesList],
    };
    const persisted = this.writeQueue.then(() => this.persist(snapshot));
    this.writeQueue = persisted.catch(() => undefined);
    return persisted;
  }

  private async persist(snapshot: PersistedWorkMemory): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }
}

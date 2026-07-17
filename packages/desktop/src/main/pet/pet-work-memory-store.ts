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
    this.entriesList.push(entry);
    while (this.entriesList.length > MAX_ENTRIES) this.entriesList.shift();
    return this.enqueuePersist();
  }

  /**
   * Open a new topic segment, appending it to the boundary history (capped at
   * MAX_SEGMENTS, most recent kept). The newest segment is the active one.
   */
  async openSegment(segment: PetTopicSegment): Promise<void> {
    this.segments.push(segment);
    while (this.segments.length > MAX_SEGMENTS) this.segments.shift();
    return this.enqueuePersist();
  }

  async setLastInteractionAt(at: number): Promise<void> {
    this.last = at;
    return this.enqueuePersist();
  }

  flush(): Promise<void> {
    return this.writeQueue;
  }

  private enqueuePersist(): Promise<void> {
    const snapshot: PersistedWorkMemory = {
      version: 1,
      lastInteractionAt: this.last,
      ...(this.segments.length > 0 ? { segments: [...this.segments] } : {}),
      entries: [...this.entriesList],
    };
    this.writeQueue = this.writeQueue.then(() => this.persist(snapshot)).catch(() => {});
    return this.writeQueue;
  }

  private async persist(snapshot: PersistedWorkMemory): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }
}

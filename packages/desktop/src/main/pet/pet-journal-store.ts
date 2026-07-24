import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_TITLE_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 4_000;
const DEFAULT_MAX_ENTRIES = 500;

export interface PetJournalEntry {
  id: string;
  /** Idempotency key: one entry per closed topic segment. */
  segmentId: string;
  title: string;
  summary: string;
  startedAt: number;
  endedAt: number;
  messageCount: number;
  /** Transcript message index window of the Mimi main conversation, for原文回看. */
  range: { start: number; end: number };
}

export interface PetJournalRecord {
  segmentId: string;
  title: string;
  summary: string;
  startedAt: number;
  endedAt: number;
  messageCount: number;
  range: { start: number; end: number };
}

interface PetJournalStoreOptions {
  now?: () => number;
  maxEntries?: number;
  /** Test seam for transient read failures. */
  readFile?: (path: string) => Promise<string>;
  /** Test seam for exercising a failed atomic replace without corrupting the target file. */
  replaceFile?: (temporaryPath: string, targetPath: string) => Promise<void>;
}

/**
 * The Mimi event journal: one entry per closed topic segment, distilled by the
 * closure pipeline into a short title + summary and pinned to the transcript
 * range it was drawn from (so the UI can lazily reveal the原文). Mirrors
 * PetMemoryStore's durability guarantees — serialized mutations persisted
 * atomically before subscribers are notified — and dedupes on `segmentId` so a
 * crash-replay or startup backfill cannot double-record a segment.
 */
export class PetJournalStore {
  private readonly entries = new Map<string, PetJournalEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly readTextFile: (path: string) => Promise<string>;
  private readonly replaceFile: (temporaryPath: string, targetPath: string) => Promise<void>;
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private loadPromise: Promise<void> | undefined;

  constructor(
    private readonly path: string,
    options: PetJournalStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    const requestedMaxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isSafeInteger(requestedMaxEntries) || requestedMaxEntries < 1) {
      throw new Error("Pet journal maxEntries must be a positive integer");
    }
    this.maxEntries = Math.min(requestedMaxEntries, DEFAULT_MAX_ENTRIES);
    this.readTextFile = options.readFile ?? ((path) => readFile(path, "utf-8"));
    this.replaceFile = options.replaceFile ?? rename;
  }

  /** Idempotent; every mutation awaits it so a write can never clobber unloaded disk state. */
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
    let text: string;
    try {
      text = await this.readTextFile(this.path);
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) {
        this.replaceEntries(new Map());
        return;
      }
      throw error;
    }
    const raw = JSON.parse(text) as { entries?: unknown };
    const loaded = new Map<string, PetJournalEntry>();
    for (const candidate of Array.isArray(raw.entries) ? raw.entries : []) {
      const entry = parseEntry(candidate);
      if (entry) loaded.set(entry.segmentId, entry);
    }
    trimEntries(loaded, this.maxEntries);
    this.replaceEntries(loaded);
  }

  /** Newest-first (by endedAt) bounded snapshot. */
  list(): PetJournalEntry[] {
    return sortedEntries(this.entries);
  }

  /** Segment ids already recorded — used by the startup backfill to skip settled segments. */
  recordedSegmentIds(): Set<string> {
    return new Set(this.entries.keys());
  }

  /**
   * Record a closed segment. Idempotent on `segmentId`: a re-record updates the
   * existing entry in place rather than appending a duplicate.
   */
  record(record: PetJournalRecord): Promise<PetJournalEntry> {
    return this.mutate((entries) => {
      const title = normalizeText(record.title, MAX_TITLE_LENGTH, "journal title");
      const summary = normalizeText(record.summary, MAX_SUMMARY_LENGTH, "journal summary");
      const segmentId = record.segmentId.trim();
      if (!segmentId) throw new Error("journal segmentId is required");
      const existing = entries.get(segmentId);
      if (existing) {
        const entry: PetJournalEntry = {
          ...existing,
          title,
          summary,
          startedAt: record.startedAt,
          endedAt: record.endedAt,
          messageCount: record.messageCount,
          range: { start: record.range.start, end: record.range.end },
        };
        entries.set(segmentId, entry);
        return entry;
      }
      if (entries.size >= this.maxEntries) {
        const oldest = oldestEntry(entries);
        if (oldest) entries.delete(oldest.segmentId);
      }
      const entry: PetJournalEntry = {
        id: `journal-${randomUUID()}`,
        segmentId,
        title,
        summary,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        messageCount: record.messageCount,
        range: { start: record.range.start, end: record.range.end },
      };
      entries.set(segmentId, entry);
      return entry;
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private mutate<T>(operation: (entries: Map<string, PetJournalEntry>) => T): Promise<T> {
    const run = this.mutationQueue
      .catch(() => undefined)
      .then(() => this.load())
      .then(async () => {
        const staged = new Map(this.entries);
        const result = operation(staged);
        await this.persist(staged);
        this.replaceEntries(staged);
        return result;
      });
    this.mutationQueue = run.then(
      () => this.notify(),
      () => undefined,
    );
    return run;
  }

  private replaceEntries(entries: ReadonlyMap<string, PetJournalEntry>): void {
    this.entries.clear();
    for (const [id, entry] of entries) this.entries.set(id, entry);
  }

  private async persist(entries: ReadonlyMap<string, PetJournalEntry>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const body = `${JSON.stringify({ version: 1, entries: sortedEntries(entries) }, null, 2)}\n`;
    try {
      await writeFile(temporary, body, { encoding: "utf-8", mode: 0o600 });
      await this.replaceFile(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function sortedEntries(entries: ReadonlyMap<string, PetJournalEntry>): PetJournalEntry[] {
  return [...entries.values()].sort((a, b) => b.endedAt - a.endedAt || b.id.localeCompare(a.id));
}

function trimEntries(entries: Map<string, PetJournalEntry>, maximum: number): void {
  const overflow = entries.size - maximum;
  if (overflow <= 0) return;
  const oldest = [...entries.values()]
    .sort((a, b) => a.endedAt - b.endedAt || a.id.localeCompare(b.id))
    .slice(0, overflow);
  for (const entry of oldest) entries.delete(entry.segmentId);
}

function oldestEntry(entries: ReadonlyMap<string, PetJournalEntry>): PetJournalEntry | undefined {
  return [...entries.values()].sort((a, b) => a.endedAt - b.endedAt || a.id.localeCompare(b.id))[0];
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

function normalizeText(text: string, maximum: number, label: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized.length > maximum ? normalized.slice(0, maximum) : normalized;
}

function parseEntry(value: unknown): PetJournalEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const range = record.range as Record<string, unknown> | undefined;
  if (
    typeof record.id !== "string" ||
    !record.id ||
    typeof record.segmentId !== "string" ||
    !record.segmentId ||
    typeof record.title !== "string" ||
    !record.title.trim() ||
    typeof record.summary !== "string" ||
    !record.summary.trim() ||
    !Number.isFinite(record.startedAt) ||
    !Number.isFinite(record.endedAt) ||
    !Number.isFinite(record.messageCount) ||
    !range ||
    typeof range !== "object" ||
    !Number.isFinite(range.start) ||
    !Number.isFinite(range.end)
  ) {
    return null;
  }
  return {
    id: record.id,
    segmentId: record.segmentId,
    title: record.title,
    summary: record.summary,
    startedAt: record.startedAt as number,
    endedAt: record.endedAt as number,
    messageCount: record.messageCount as number,
    range: { start: range.start as number, end: range.end as number },
  };
}

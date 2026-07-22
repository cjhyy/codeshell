import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_MEMORY_TEXT_LENGTH = 2_000;
const DEFAULT_MAX_ENTRIES = 200;

export type PetMemorySource = "user" | "mimi";

export interface PetMemoryEntry {
  id: string;
  text: string;
  source: PetMemorySource;
  createdAt: number;
  updatedAt: number;
}

interface PetMemoryStoreOptions {
  now?: () => number;
  maxEntries?: number;
  /** Test seam for exercising a failed atomic replace without corrupting the target file. */
  replaceFile?: (temporaryPath: string, targetPath: string) => Promise<void>;
}

/**
 * Durable, user-editable Mimi memory: small facts, preferences, and standing
 * instructions injected into every manager turn. Deliberately session-like in
 * ergonomics — listable, editable, and removable from both the desktop UI and
 * Mimi's Memory tool. Mutations are serialized and persisted atomically before
 * subscribers are notified, mirroring PetLongTaskStore's guarantees.
 */
export class PetMemoryStore {
  private readonly entries = new Map<string, PetMemoryEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly replaceFile: (temporaryPath: string, targetPath: string) => Promise<void>;
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private loadPromise: Promise<void> | undefined;

  constructor(
    private readonly path: string,
    options: PetMemoryStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    const requestedMaxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isSafeInteger(requestedMaxEntries) || requestedMaxEntries < 1) {
      throw new Error("Pet memory maxEntries must be a positive integer");
    }
    this.maxEntries = Math.min(requestedMaxEntries, DEFAULT_MAX_ENTRIES);
    this.replaceFile = options.replaceFile ?? rename;
  }

  /** Idempotent; every mutation awaits it so a write can never clobber unloaded disk state. */
  load(): Promise<void> {
    this.loadPromise ??= this.doLoad();
    return this.loadPromise;
  }

  private async doLoad(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf-8")) as { entries?: unknown };
      const loaded = new Map<string, PetMemoryEntry>();
      for (const candidate of Array.isArray(raw.entries) ? raw.entries : []) {
        const entry = parseEntry(candidate);
        if (entry) loaded.set(entry.id, entry);
      }
      trimEntries(loaded, this.maxEntries);
      this.replaceEntries(loaded);
    } catch {
      // Missing or corrupt file: start empty; the next mutation rewrites it.
    }
  }

  /** Newest-first (by updatedAt) bounded snapshot. */
  list(): PetMemoryEntry[] {
    return sortedEntries(this.entries);
  }

  remember(text: string, source: PetMemorySource): Promise<PetMemoryEntry> {
    return this.mutate((entries) => {
      const normalized = normalizeText(text);
      const at = this.now();
      const entry: PetMemoryEntry = {
        id: `mem-${randomUUID()}`,
        text: normalized,
        source,
        createdAt: at,
        updatedAt: at,
      };
      entries.set(entry.id, entry);
      trimEntries(entries, this.maxEntries);
      return entry;
    });
  }

  update(id: string, text: string): Promise<PetMemoryEntry> {
    return this.mutate((entries) => {
      const existing = entries.get(id);
      if (!existing) throw new Error(`memory not found: ${id}`);
      const entry: PetMemoryEntry = {
        ...existing,
        text: normalizeText(text),
        updatedAt: Math.max(this.now(), existing.updatedAt + 1),
      };
      entries.set(id, entry);
      return entry;
    });
  }

  forget(id: string): Promise<PetMemoryEntry> {
    return this.mutate((entries) => {
      const existing = entries.get(id);
      if (!existing) throw new Error(`memory not found: ${id}`);
      entries.delete(id);
      return existing;
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private mutate<T>(operation: (entries: Map<string, PetMemoryEntry>) => T): Promise<T> {
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

  private replaceEntries(entries: ReadonlyMap<string, PetMemoryEntry>): void {
    this.entries.clear();
    for (const [id, entry] of entries) this.entries.set(id, entry);
  }

  private async persist(entries: ReadonlyMap<string, PetMemoryEntry>): Promise<void> {
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

function sortedEntries(entries: ReadonlyMap<string, PetMemoryEntry>): PetMemoryEntry[] {
  return [...entries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function trimEntries(entries: Map<string, PetMemoryEntry>, maximum: number): void {
  const overflow = entries.size - maximum;
  if (overflow <= 0) return;
  const oldest = [...entries.values()].sort((a, b) => a.updatedAt - b.updatedAt).slice(0, overflow);
  for (const entry of oldest) entries.delete(entry.id);
}

function normalizeText(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!normalized) throw new Error("memory text is required");
  if (normalized.length > MAX_MEMORY_TEXT_LENGTH) {
    throw new Error(`memory text is too long (maximum ${MAX_MEMORY_TEXT_LENGTH} characters)`);
  }
  return normalized;
}

function parseEntry(value: unknown): PetMemoryEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    !record.id ||
    typeof record.text !== "string" ||
    !record.text.trim() ||
    record.text.length > MAX_MEMORY_TEXT_LENGTH ||
    (record.source !== "user" && record.source !== "mimi") ||
    !Number.isFinite(record.createdAt) ||
    !Number.isFinite(record.updatedAt)
  ) {
    return null;
  }
  return {
    id: record.id,
    text: record.text,
    source: record.source,
    createdAt: record.createdAt as number,
    updatedAt: record.updatedAt as number,
  };
}

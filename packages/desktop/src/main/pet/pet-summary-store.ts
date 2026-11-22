/**
 * Persistent cache for Mimi closure-summaries, keyed by session id. Each entry
 * carries the summary text plus the `terminalAt` it was generated for, which
 * doubles as the freshness token: a newer terminalAt supersedes the cached
 * text (the session finished again after being summarized). An empty `text`
 * ("") is a deliberate no-value marker — the session was judged to have no
 * worthwhile takeaway — and is stored so we do not re-ask the aux model.
 *
 * Persistence mirrors pet-work-inbox-store: async load on construct, a
 * debounced atomic-rename flush on mutate, bounded size with oldest-write
 * eviction. `get`/`set` are synchronous over the in-memory map; callers await
 * `load()` once before use and may `flush()` in teardown.
 */
import { readBoundedJson, writeOwnerJsonAtomic } from "./bounded-json-store.js";

const MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 500;

export interface PetSummaryEntry {
  terminalAt: number;
  text: string;
}

export interface PetSummaryStore {
  load(): Promise<void>;
  get(sessionId: string): PetSummaryEntry | undefined;
  set(sessionId: string, terminalAt: number, text: string): void;
  flush(): Promise<void>;
}

interface PetSummaryFileEntry {
  sessionId: string;
  terminalAt: number;
  text: string;
}

interface PetSummaryFile {
  version: 2;
  entries: PetSummaryFileEntry[];
}

function isValidEntry(value: unknown): value is PetSummaryFileEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sessionId === "string" &&
    !!record.sessionId &&
    typeof record.terminalAt === "number" &&
    Number.isFinite(record.terminalAt) &&
    typeof record.text === "string"
  );
}

export function createPetSummaryStore(
  filePath: string,
  options: { maxEntries?: number } = {},
): PetSummaryStore {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  // Map preserves insertion order; re-setting a key deletes+reinserts so it
  // moves to the newest position, keeping eviction honest (oldest write first).
  const entries = new Map<string, PetSummaryEntry>();
  let loadPromise: Promise<void> | undefined;
  let writeQueue: Promise<void> = Promise.resolve();

  async function doLoad(): Promise<void> {
    let parsed: Partial<PetSummaryFile> | null | undefined;
    try {
      parsed = (await readBoundedJson(filePath, MAX_FILE_BYTES)) as
        | Partial<PetSummaryFile>
        | undefined;
    } catch {
      return;
    }
    // v1 accepted arbitrary model prose and could surface ordinary completion
    // summaries as follow-ups. Ignore it so v2 regenerates through the strict
    // FOLLOW_UP/NONE envelope while preserving dismissals in the separate
    // work-inbox store.
    if (parsed?.version !== 2 || !Array.isArray(parsed.entries)) return;
    for (const candidate of parsed.entries) {
      if (!isValidEntry(candidate)) continue;
      entries.set(candidate.sessionId, {
        terminalAt: candidate.terminalAt,
        text: candidate.text,
      });
    }
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  async function persist(): Promise<void> {
    const file: PetSummaryFile = {
      version: 2,
      entries: [...entries.entries()].map(([sessionId, entry]) => ({
        sessionId,
        terminalAt: entry.terminalAt,
        text: entry.text,
      })),
    };
    await writeOwnerJsonAtomic(filePath, file, MAX_FILE_BYTES);
  }

  function scheduleFlush(): void {
    const write = writeQueue.catch(() => undefined).then(() => persist());
    // Keep the rejection observable through flush(), without creating an
    // unhandled promise when a caller intentionally uses synchronous set().
    void write.catch(() => undefined);
    writeQueue = write;
  }

  return {
    load() {
      if (!loadPromise) loadPromise = doLoad();
      return loadPromise;
    },
    get(sessionId) {
      return entries.get(sessionId);
    },
    set(sessionId, terminalAt, text) {
      const current = entries.get(sessionId);
      if (current && current.terminalAt > terminalAt) return;
      // Delete first so a re-set moves the key to the newest insertion slot.
      entries.delete(sessionId);
      entries.set(sessionId, { terminalAt, text });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      scheduleFlush();
    },
    flush() {
      return writeQueue;
    },
  };
}

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
  /** Test seam for transient read failures. */
  readFile?: (path: string) => Promise<string>;
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
  private readonly readTextFile: (path: string) => Promise<string>;
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
    this.readTextFile = options.readFile ?? ((path) => readFile(path, "utf-8"));
    this.replaceFile = options.replaceFile ?? rename;
  }

  /** Idempotent; every mutation awaits it so a write can never clobber unloaded disk state. */
  load(): Promise<void> {
    if (!this.loadPromise) {
      const attempt = this.doLoad();
      this.loadPromise = attempt;
      // A transient EIO/EACCES must not become a permanently cached empty
      // store. Clear only this failed attempt so a later load/mutation retries.
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
    // Corrupt JSON is not equivalent to a missing library. Rejecting keeps all
    // mutations fail-closed until the file is repaired instead of overwriting
    // it from an empty staged map.
    const raw = JSON.parse(text) as { entries?: unknown };
    const loaded = new Map<string, PetMemoryEntry>();
    for (const candidate of Array.isArray(raw.entries) ? raw.entries : []) {
      const entry = parseEntry(candidate);
      if (entry) loaded.set(entry.id, entry);
    }
    trimEntries(loaded, this.maxEntries);
    this.replaceEntries(loaded);
  }

  /** Newest-first (by updatedAt) bounded snapshot. */
  list(): PetMemoryEntry[] {
    return sortedEntries(this.entries);
  }

  remember(text: string, source: PetMemorySource): Promise<PetMemoryEntry> {
    return this.mutate((entries) => {
      const normalized = normalizeText(text);
      const at = nextMutationTime(entries, this.now());
      const equivalent = findEquivalentEntry(entries, normalized);
      if (equivalent) {
        // Mimi may recognize a user-authored memory, but must not rewrite its
        // wording or ownership merely by calling remember with a paraphrase.
        if (source === "mimi" && equivalent.source === "user") return equivalent;
        const entry: PetMemoryEntry = {
          ...equivalent,
          text: normalized,
          // An explicit user write upgrades an equivalent Mimi inference to
          // user ownership so later Mimi capacity pressure cannot evict it.
          ...(source === "user" ? { source: "user" as const } : {}),
          updatedAt: at,
        };
        entries.set(entry.id, entry);
        return entry;
      }
      if (entries.size >= this.maxEntries) {
        const evictable =
          oldestMimiEntry(entries) ?? (source === "user" ? oldestEntry(entries) : undefined);
        if (!evictable) {
          throw new Error(
            "Mimi memory is full of user-authored entries; remove one explicitly before adding another",
          );
        }
        entries.delete(evictable.id);
      }
      const entry: PetMemoryEntry = {
        id: `mem-${randomUUID()}`,
        text: normalized,
        source,
        createdAt: at,
        updatedAt: at,
      };
      entries.set(entry.id, entry);
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
        updatedAt: nextMutationTime(entries, this.now()),
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

/**
 * `updatedAt` doubles as the durable mutation order. Wall clocks can have
 * millisecond precision, move backwards, or be fixed by a caller, so every
 * successful mutation advances beyond the newest stored entry. Because the
 * value is persisted, a reloaded store continues the same order; because
 * mutations are serialized, concurrent callers cannot receive the same tick.
 */
function nextMutationTime(entries: ReadonlyMap<string, PetMemoryEntry>, now: number): number {
  let latest = Number.NEGATIVE_INFINITY;
  for (const entry of entries.values()) latest = Math.max(latest, entry.updatedAt);
  return latest === Number.NEGATIVE_INFINITY ? now : Math.max(now, latest + 1);
}

function trimEntries(entries: Map<string, PetMemoryEntry>, maximum: number): void {
  const overflow = entries.size - maximum;
  if (overflow <= 0) return;
  const oldest = [...entries.values()]
    .sort((a, b) => {
      if (a.source !== b.source) return a.source === "mimi" ? -1 : 1;
      return a.updatedAt - b.updatedAt;
    })
    .slice(0, overflow);
  for (const entry of oldest) entries.delete(entry.id);
}

function oldestMimiEntry(entries: ReadonlyMap<string, PetMemoryEntry>): PetMemoryEntry | undefined {
  return [...entries.values()]
    .filter((entry) => entry.source === "mimi")
    .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))[0];
}

function oldestEntry(entries: ReadonlyMap<string, PetMemoryEntry>): PetMemoryEntry | undefined {
  return [...entries.values()].sort(
    (a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id),
  )[0];
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

function normalizeText(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!normalized) throw new Error("memory text is required");
  if (normalized.length > MAX_MEMORY_TEXT_LENGTH) {
    throw new Error(`memory text is too long (maximum ${MAX_MEMORY_TEXT_LENGTH} characters)`);
  }
  return normalized;
}

/**
 * Find a conservatively equivalent memory without relying on a model or locale.
 * Only exact canonical matches are eligible: the canonicalizer removes framing
 * and applies a small set of high-confidence aliases. Generic fuzzy similarity
 * is intentionally excluded because a single changed project, path, or number
 * can be the entire durable fact even when the surrounding long text is equal.
 */
function findEquivalentEntry(
  entries: ReadonlyMap<string, PetMemoryEntry>,
  text: string,
): PetMemoryEntry | undefined {
  const incoming = canonicalMemoryText(text);
  if (!incoming) return undefined;
  let best: PetMemoryEntry | undefined;
  for (const entry of entries.values()) {
    if (canonicalMemoryText(entry.text) !== incoming) continue;
    if (
      !best ||
      entry.updatedAt > best.updatedAt ||
      (entry.updatedAt === best.updatedAt && entry.id < best.id)
    ) {
      best = entry;
    }
  }
  return best;
}

const MEMORY_PHRASE_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:不太|不)(?:喜欢|喜爱|偏爱|偏好)|(?:讨厌|厌恶)/gu, " 不偏好 "],
  [/(?<!不)(?:更)?(?:喜欢|喜爱|偏爱|偏好)|(?:倾向于)/gu, " 偏好 "],
  [/(?:暗黑|黑暗|深色|暗色)(?:的)?(?:主题|模式)/gu, " 暗色主题 "],
  [/(?:固定在|固定于)/gu, " 固定于 "],
  [/\b(?:does\s+not|doesn't|do\s+not|don't)\s+(?:like|prefer)\b/giu, " not prefer "],
  [/\b(?:dislikes?|hates?)\b/giu, " not prefer "],
  [/\b(?:likes?|prefers?|favou?rs?)\b/giu, " prefer "],
  [/\bdark\s+(?:mode|theme)\b/giu, " dark theme "],
];

function canonicalMemoryText(text: string): string {
  let canonical = text.normalize("NFKC").replace(/[’‘]/gu, "'").trim();
  canonical = canonical
    .replace(
      /^(?:(?:请\s*)?(?:帮我\s*)?(?:记住|记得)(?:一下)?(?:这件事)?|(?:please\s+)?(?:remember|note)(?:\s+that)?)\s*(?:[:：,，]\s*)?/iu,
      "",
    )
    .replace(/^(?:用户|我)(?:的)?\s*/u, "")
    .replace(/^(?:the\s+)?user(?:'s)?\s+/iu, "")
    .replace(/^(?:i|my)\s+/iu, "");
  for (const [pattern, replacement] of MEMORY_PHRASE_ALIASES) {
    canonical = canonical.replace(pattern, replacement);
  }
  canonical = canonical
    .replace(/(?:非常|十分|很|通常)(?=偏好)/gu, "")
    .replace(/偏好\s*(?:使用|采用)\s*/gu, "偏好 ")
    .replace(/\b(?:really|generally)\s+(?=prefer\b)/giu, "")
    .replace(/\bprefer\s+(?:using|to\s+use)\b/giu, " prefer ")
    .replace(/[。！？!?；;]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return canonical;
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

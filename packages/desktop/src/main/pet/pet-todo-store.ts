import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PET_TODO_STATUSES, type PetTodoItem, type PetTodoStatus } from "@cjhyy/code-shell-pet";

const MAX_TODO_TEXT_LENGTH = 500;

/**
 * Cap on ACTIVE (non-archived) todos — what "the list is full" should mean.
 *
 * The single 500-entry cap this replaces counted archived rows too, while
 * archiving only flips `status` and there was no purge/delete API. So the limit
 * was a lifetime total: once 500 todos had ever existed, creation failed
 * permanently — even with an empty visible list — and the error told the user to
 * "archive some old todos", which could not possibly unblock them.
 */
const MAX_ACTIVE_TODO_ENTRIES = 500;

/**
 * How many archived todos to keep as history. Beyond this the OLDEST archived
 * rows are dropped on the next mutation, so archiving genuinely reclaims space
 * instead of accumulating forever. Kept well above the active cap so normal use
 * never loses history a user might still want.
 */
const MAX_ARCHIVED_TODO_ENTRIES = 2_000;

interface PetTodoStoreOptions {
  now?: () => number;
  /**
   * Override archived-history retention. Production uses the default; tests set
   * a small value so retention is verifiable without thousands of atomic writes.
   */
  maxArchivedEntries?: number;
}

/**
 * Durable personal todo library shared by the Pet UI and Mimi's atomic tools.
 *
 * It intentionally does not read or write Work Session TodoWrite snapshots:
 * those are ephemeral agent execution steps, while these items survive across
 * sessions and have stable ids suitable for buttons and tool calls.
 */
export class PetTodoStore {
  private readonly entries = new Map<string, PetTodoItem>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly maxArchivedEntries: number;
  private loadPromise: Promise<void> | undefined;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly path: string,
    options: PetTodoStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.maxArchivedEntries = options.maxArchivedEntries ?? MAX_ARCHIVED_TODO_ENTRIES;
  }

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
    let raw: string;
    try {
      raw = await readFile(this.path, "utf-8");
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) return;
      throw error;
    }
    const parsed = JSON.parse(raw) as { entries?: unknown };
    const entries = new Map<string, PetTodoItem>();
    for (const candidate of Array.isArray(parsed.entries) ? parsed.entries : []) {
      const item = parseTodo(candidate);
      if (item) entries.set(item.id, item);
    }
    this.replace(entries);
  }

  list(options: { includeArchived?: boolean } = {}): PetTodoItem[] {
    return [...this.entries.values()]
      .filter((entry) => options.includeArchived || entry.status !== "archived")
      .sort(
        (left, right) =>
          statusRank(left.status) - statusRank(right.status) ||
          right.updatedAt - left.updatedAt ||
          left.id.localeCompare(right.id),
      );
  }

  create(text: string): Promise<PetTodoItem> {
    return this.mutate((entries) => {
      // Count only ACTIVE items: archiving must actually free capacity.
      let active = 0;
      for (const entry of entries.values()) {
        if (entry.status !== "archived") active += 1;
      }
      if (active >= MAX_ACTIVE_TODO_ENTRIES) {
        throw new Error(
          `待办列表已满（${MAX_ACTIVE_TODO_ENTRIES} 条未归档），请先归档或删除一些待办`,
        );
      }
      const at = nextMutationTime(entries, this.now());
      const item: PetTodoItem = {
        id: `todo-${randomUUID()}`,
        text: normalizeText(text),
        status: "pending",
        createdAt: at,
        updatedAt: at,
      };
      entries.set(item.id, item);
      return item;
    });
  }

  update(id: string, text: string): Promise<PetTodoItem> {
    return this.mutate((entries) => {
      const current = requiredTodo(entries, id);
      const item = {
        ...current,
        text: normalizeText(text),
        updatedAt: nextMutationTime(entries, this.now()),
      };
      entries.set(id, item);
      return item;
    });
  }

  setStatus(id: string, status: PetTodoStatus): Promise<PetTodoItem> {
    if (!(PET_TODO_STATUSES as readonly unknown[]).includes(status)) {
      return Promise.reject(new Error(`invalid todo status: ${String(status)}`));
    }
    return this.mutate((entries) => {
      const current = requiredTodo(entries, id);
      const item = {
        ...current,
        status,
        updatedAt: nextMutationTime(entries, this.now()),
      };
      entries.set(id, item);
      return item;
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private mutate<T>(operation: (entries: Map<string, PetTodoItem>) => T): Promise<T> {
    const run = this.mutationQueue
      .catch(() => undefined)
      .then(() => this.load())
      .then(async () => {
        const staged = new Map(this.entries);
        const result = operation(staged);
        // Every write funnels through here, so history retention is enforced in
        // one place rather than per-operation.
        pruneArchivedHistory(staged, this.maxArchivedEntries);
        await this.persist(staged);
        this.replace(staged);
        return result;
      });
    this.mutationQueue = run.then(
      () => this.notify(),
      () => undefined,
    );
    return run;
  }

  private replace(entries: ReadonlyMap<string, PetTodoItem>): void {
    this.entries.clear();
    for (const [id, entry] of entries) this.entries.set(id, entry);
  }

  private async persist(entries: ReadonlyMap<string, PetTodoItem>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const body = `${JSON.stringify(
      {
        version: 1,
        entries: [...entries.values()].sort(
          (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
        ),
      },
      null,
      2,
    )}\n`;
    try {
      await writeFile(temporary, body, { encoding: "utf-8", mode: 0o600 });
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function normalizeText(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!normalized) throw new Error("待办内容不能为空");
  if (normalized.length > MAX_TODO_TEXT_LENGTH) {
    throw new Error(`待办内容不能超过 ${MAX_TODO_TEXT_LENGTH} 个字符`);
  }
  return normalized;
}

function requiredTodo(entries: ReadonlyMap<string, PetTodoItem>, id: string): PetTodoItem {
  const item = entries.get(id);
  if (!item) throw new Error(`todo not found: ${id}`);
  return item;
}

function statusRank(status: PetTodoStatus): number {
  if (status === "in_progress") return 0;
  if (status === "blocked") return 1;
  if (status === "pending") return 2;
  if (status === "completed") return 3;
  return 4;
}

/**
 * Trim archived history to MAX_ARCHIVED_TODO_ENTRIES, dropping the oldest first.
 *
 * Without this, archiving never reclaims anything: it only flips `status`, and
 * there is no delete API, so the file grows without bound and (before the active
 * cap split) eventually blocked all creation. Mutates `entries` in place; runs on
 * every mutation, and is a no-op below the limit.
 */
function pruneArchivedHistory(entries: Map<string, PetTodoItem>, limit: number): void {
  const archived: PetTodoItem[] = [];
  for (const entry of entries.values()) {
    if (entry.status === "archived") archived.push(entry);
  }
  if (archived.length <= limit) return;
  // Oldest-first by archive time (updatedAt), stable on id.
  archived.sort(
    (left, right) => left.updatedAt - right.updatedAt || left.id.localeCompare(right.id),
  );
  for (const entry of archived.slice(0, archived.length - limit)) {
    entries.delete(entry.id);
  }
}

function nextMutationTime(entries: ReadonlyMap<string, PetTodoItem>, now: number): number {
  let latest = Number.NEGATIVE_INFINITY;
  for (const entry of entries.values()) latest = Math.max(latest, entry.updatedAt);
  return latest === Number.NEGATIVE_INFINITY ? now : Math.max(now, latest + 1);
}

function parseTodo(value: unknown): PetTodoItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    !/^todo-[A-Za-z0-9-]{1,128}$/u.test(record.id) ||
    typeof record.text !== "string" ||
    !record.text.trim() ||
    record.text.length > MAX_TODO_TEXT_LENGTH ||
    !(PET_TODO_STATUSES as readonly unknown[]).includes(record.status) ||
    !Number.isFinite(record.createdAt) ||
    !Number.isFinite(record.updatedAt)
  ) {
    return null;
  }
  return {
    id: record.id,
    text: record.text.replace(/\s+/gu, " ").trim(),
    status: record.status as PetTodoStatus,
    createdAt: Number(record.createdAt),
    updatedAt: Number(record.updatedAt),
    ...(typeof record.workspaceId === "string" ? { workspaceId: record.workspaceId } : {}),
    ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
  };
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  MAX_PET_WORK_INBOX_DISMISSED_ITEMS,
  MAX_PET_WORK_ITEM_ID_LENGTH,
  isPetFollowUpStateId,
  isPetWorkItemId,
} from "../../shared/pet-work-item-id.js";

// Re-export the shared id contract so existing importers of this module keep working;
// the pattern/limits live in shared/pet-work-item-id.ts to stay in sync with the renderer.
export { MAX_PET_WORK_INBOX_DISMISSED_ITEMS, MAX_PET_WORK_ITEM_ID_LENGTH, isPetWorkItemId };

export interface PetWorkInboxSnapshot {
  revision: number;
  dismissedIds: string[];
}

export interface PetWorkInboxDurableAddResult {
  snapshot: PetWorkInboxSnapshot;
  addedIds: string[];
}

interface PetWorkInboxFile {
  version: 1;
  revision: number;
  dismissedIds: string[];
}

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isPetWorkItemId))].slice(-MAX_PET_WORK_INBOX_DISMISSED_ITEMS);
}

/**
 * Bounds the dismissed history by evicting the oldest session-row ids first.
 * `follow-up:*` handled receipts go last: their summary rows outlive session
 * churn (rows live as long as the session), so evicting one would resurrect an
 * already-handled follow-up after ~1000 later dismissals.
 */
function evictOverflow(ids: Set<string>): boolean {
  let changed = false;
  while (ids.size > MAX_PET_WORK_INBOX_DISMISSED_ITEMS) {
    let victim: string | undefined;
    for (const id of ids) {
      if (!isPetFollowUpStateId(id)) {
        victim = id;
        break;
      }
    }
    ids.delete(victim ?? ids.values().next().value!);
    changed = true;
  }
  return changed;
}

export class PetWorkInboxStore {
  private readonly dismissedIds = new Set<string>();
  private readonly listeners = new Set<(snapshot: PetWorkInboxSnapshot) => void>();
  private revision = 0;
  private writeQueue = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<PetWorkInboxFile>;
      const revision = parsed.revision;
      if (
        parsed.version !== 1 ||
        typeof revision !== "number" ||
        !Number.isSafeInteger(revision) ||
        revision < 0
      ) {
        return;
      }
      this.dismissedIds.clear();
      for (const id of normalizeIds(parsed.dismissedIds)) this.dismissedIds.add(id);
      this.revision = revision;
    } catch {
      // Missing or corrupt preferences safely fall back to an empty inbox state.
    }
  }

  getSnapshot(): PetWorkInboxSnapshot {
    return {
      revision: this.revision,
      dismissedIds: [...this.dismissedIds],
    };
  }

  add(ids: readonly string[]): PetWorkInboxSnapshot {
    let changed = false;
    for (const id of normalizeIds(ids)) {
      if (this.dismissedIds.has(id)) continue;
      this.dismissedIds.add(id);
      changed = true;
    }
    if (evictOverflow(this.dismissedIds)) changed = true;
    if (changed) this.changed();
    return this.getSnapshot();
  }

  /**
   * Transactional host-action mutation: persist a staged snapshot before it is
   * exposed to readers or listeners. A failed disk write therefore leaves no
   * misleading in-memory "handled" state for Mimi to report.
   */
  async addDurably(ids: readonly string[]): Promise<PetWorkInboxSnapshot> {
    return (await this.addDurablyWithResult(ids)).snapshot;
  }

  /**
   * Durable counterpart of clear() used by the renderer IPC. It shares the
   * same serialized queue as Mimi's exact follow-up claims, so a clear/add
   * race has one deterministic disk order instead of exposing transient state.
   * Like clear(), it only restores session rows: `follow-up:*` handled state
   * survives, otherwise every already-handled follow-up would resurrect.
   */
  async clearDurably(): Promise<PetWorkInboxSnapshot> {
    const previous = this.writeQueue;
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const retained = [...this.dismissedIds].filter(isPetFollowUpStateId);
        if (retained.length === this.dismissedIds.size) {
          await this.persist();
          return this.getSnapshot();
        }
        const staged: PetWorkInboxSnapshot = {
          revision: this.revision + 1,
          dismissedIds: retained,
        };
        await this.persist(staged);
        // Re-filter the latest memory state: a follow-up claim may have landed
        // while the staged file was being written and must not be dropped.
        for (const id of [...this.dismissedIds]) {
          if (!isPetFollowUpStateId(id)) this.dismissedIds.delete(id);
        }
        this.revision += 1;
        const snapshot = this.getSnapshot();
        for (const listener of this.listeners) listener(snapshot);
        return snapshot;
      });
    if (this.writeQueue === previous) {
      const tail = run.then(() => undefined);
      void tail.catch(() => undefined);
      this.writeQueue = tail;
    }
    return await run;
  }

  /**
   * Atomically add one id only if it is still open when this mutation reaches
   * the serialized durable queue. UI and Mimi can race the same follow-up;
   * exactly one caller receives `added: true` and may report success.
   */
  async addIfAbsentDurably(
    id: string,
  ): Promise<{ added: boolean; snapshot: PetWorkInboxSnapshot }> {
    const normalized = normalizeIds([id]);
    if (normalized.length !== 1 || normalized[0] !== id) {
      throw new Error("invalid Pet work inbox id");
    }
    const result = await this.addDurablyWithResult(normalized);
    return { added: result.addedIds.includes(id), snapshot: result.snapshot };
  }

  private async addDurablyWithResult(
    ids: readonly string[],
  ): Promise<PetWorkInboxDurableAddResult> {
    const normalized = normalizeIds(ids);
    if (normalized.length === 0) {
      return { snapshot: this.getSnapshot(), addedIds: [] };
    }
    const previous = this.writeQueue;
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const stagedIds = new Set(this.dismissedIds);
        const addedIds: string[] = [];
        for (const id of normalized) {
          if (stagedIds.has(id)) continue;
          stagedIds.add(id);
          addedIds.push(id);
        }
        let changed = addedIds.length > 0;
        if (evictOverflow(stagedIds)) changed = true;
        if (!changed) {
          // Also repairs a prior failed legacy/UI write before declaring an
          // already-present item durable.
          await this.persist();
          return { snapshot: this.getSnapshot(), addedIds: [] };
        }

        const staged: PetWorkInboxSnapshot = {
          revision: this.revision + 1,
          dismissedIds: [...stagedIds],
        };
        await this.persist(staged);

        // Synchronous UI mutations may have occurred while the staged file was
        // being written. Apply this action on top of the latest memory state;
        // their already-queued write will then persist the merged state.
        for (const id of normalized) this.dismissedIds.add(id);
        evictOverflow(this.dismissedIds);
        this.revision += 1;
        const snapshot = this.getSnapshot();
        for (const listener of this.listeners) listener(snapshot);
        return { snapshot, addedIds };
      });
    // Do not replace a later queue tail installed by a synchronous UI mutation
    // while `run` is awaiting the filesystem.
    if (this.writeQueue === previous) {
      const tail = run.then(() => undefined);
      void tail.catch(() => undefined);
      this.writeQueue = tail;
    }
    return await run;
  }

  /** Restores session rows only; `follow-up:*` handled state is kept (see clearDurably). */
  clear(): PetWorkInboxSnapshot {
    let changed = false;
    for (const id of [...this.dismissedIds]) {
      if (isPetFollowUpStateId(id)) continue;
      this.dismissedIds.delete(id);
      changed = true;
    }
    if (changed) this.changed();
    return this.getSnapshot();
  }

  flush(): Promise<void> {
    return this.writeQueue;
  }

  subscribe(listener: (snapshot: PetWorkInboxSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.revision += 1;
    const write = this.writeQueue.catch(() => undefined).then(() => this.persist());
    // Keep the rejection observable through flush(), but mark it handled when
    // callers intentionally use the legacy synchronous mutation API.
    void write.catch(() => undefined);
    this.writeQueue = write;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private async persist(snapshot = this.getSnapshot()): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const file: PetWorkInboxFile = {
      version: 1,
      revision: snapshot.revision,
      dismissedIds: snapshot.dismissedIds,
    };
    try {
      await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600).catch(() => undefined);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const MAX_PET_WORK_INBOX_DISMISSED_ITEMS = 1_000;
export const MAX_PET_WORK_ITEM_ID_LENGTH = 512;

const PET_WORK_ITEM_ID_PATTERN =
  /^(?:running|pending|follow-up|completed|other):[^\u0000\r\n]+$/;

export interface PetWorkInboxSnapshot {
  revision: number;
  dismissedIds: string[];
}

interface PetWorkInboxFile {
  version: 1;
  revision: number;
  dismissedIds: string[];
}

export function isPetWorkItemId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PET_WORK_ITEM_ID_LENGTH &&
    PET_WORK_ITEM_ID_PATTERN.test(value)
  );
}

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isPetWorkItemId))].slice(-MAX_PET_WORK_INBOX_DISMISSED_ITEMS);
}

export class PetWorkInboxStore {
  private readonly dismissedIds = new Set<string>();
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
    while (this.dismissedIds.size > MAX_PET_WORK_INBOX_DISMISSED_ITEMS) {
      this.dismissedIds.delete(this.dismissedIds.values().next().value!);
      changed = true;
    }
    if (changed) this.changed();
    return this.getSnapshot();
  }

  clear(): PetWorkInboxSnapshot {
    if (this.dismissedIds.size > 0) {
      this.dismissedIds.clear();
      this.changed();
    }
    return this.getSnapshot();
  }

  flush(): Promise<void> {
    return this.writeQueue;
  }

  private changed(): void {
    this.revision += 1;
    this.writeQueue = this.writeQueue.then(() => this.persist()).catch(() => {});
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    const file: PetWorkInboxFile = {
      version: 1,
      revision: this.revision,
      dismissedIds: [...this.dismissedIds],
    };
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }
}

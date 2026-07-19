import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  PET_LONG_TASK_SCHEMA_VERSION,
  createPetLongTask,
  parsePetLongTask,
  transitionPetLongTask,
  type CreatePetLongTaskInput,
  type PetLongTask,
  type PetLongTaskSnapshot,
  type PetLongTaskTransition,
} from "@cjhyy/code-shell-pet";

const MAX_STORED_TASKS = 500;

interface PetLongTaskFile {
  version: typeof PET_LONG_TASK_SCHEMA_VERSION;
  revision: number;
  observedAt: number;
  tasks: PetLongTask[];
}

function isActive(task: PetLongTask): boolean {
  return task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled";
}

/**
 * Durable, atomic Pet task journal. The materialized task contains a bounded
 * event history; every mutation is persisted before subscribers see it.
 */
export class PetLongTaskStore {
  private readonly tasks = new Map<string, PetLongTask>();
  private readonly listeners = new Set<(snapshot: PetLongTaskSnapshot) => void>();
  private revision = 0;
  private observedAt = 0;
  private writeQueue = Promise.resolve();
  private mutationQueue = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<PetLongTaskFile>;
      if (parsed.version !== PET_LONG_TASK_SCHEMA_VERSION || !Array.isArray(parsed.tasks)) return;
      this.tasks.clear();
      for (const row of parsed.tasks) {
        const task = parsePetLongTask(row);
        if (task) this.tasks.set(task.id, task);
      }
      this.trim();
      this.revision =
        typeof parsed.revision === "number" && Number.isSafeInteger(parsed.revision)
          ? Math.max(0, parsed.revision)
          : 0;
      this.observedAt = typeof parsed.observedAt === "number" ? parsed.observedAt : this.now();
    } catch {
      // Missing/corrupt task state starts empty. One malformed row never blocks Mimi.
    }
  }

  getSnapshot(): PetLongTaskSnapshot {
    return {
      revision: this.revision,
      observedAt: this.observedAt,
      tasks: [...this.tasks.values()]
        .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
        .map((task) => structuredClone(task)),
    };
  }

  get(taskId: string): PetLongTask | undefined {
    const task = this.tasks.get(taskId);
    return task ? structuredClone(task) : undefined;
  }

  findByOriginClientMessageId(clientMessageId: string): PetLongTask | undefined {
    const task = [...this.tasks.values()].find(
      (candidate) => candidate.originClientMessageId === clientMessageId,
    );
    return task ? structuredClone(task) : undefined;
  }

  latestForSession(sessionId: string): PetLongTask | undefined {
    const task = [...this.tasks.values()]
      .filter((candidate) => candidate.sessionId === sessionId)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    return task ? structuredClone(task) : undefined;
  }

  activeForSession(sessionId: string): PetLongTask | undefined {
    const task = [...this.tasks.values()]
      .filter((candidate) => candidate.sessionId === sessionId && isActive(candidate))
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    return task ? structuredClone(task) : undefined;
  }

  activeTasks(): PetLongTask[] {
    return this.getSnapshot().tasks.filter(isActive);
  }

  async create(input: CreatePetLongTaskInput): Promise<PetLongTask> {
    return this.enqueueMutation(async () => {
      const existing = this.findByOriginClientMessageId(input.originClientMessageId);
      if (existing) return existing;
      const task = createPetLongTask(input);
      const beforeRevision = this.revision;
      const beforeObservedAt = this.observedAt;
      this.tasks.set(task.id, task);
      try {
        await this.changed();
      } catch (error) {
        this.tasks.delete(task.id);
        this.revision = beforeRevision;
        this.observedAt = beforeObservedAt;
        throw error;
      }
      return structuredClone(task);
    });
  }

  async transition(taskId: string, transition: PetLongTaskTransition): Promise<PetLongTask> {
    return this.enqueueMutation(async () => {
      const current = this.tasks.get(taskId);
      if (!current) throw new Error(`Unknown Pet long task: ${taskId}`);
      const next = transitionPetLongTask(current, transition);
      if (next === current) return structuredClone(current);
      const beforeRevision = this.revision;
      const beforeObservedAt = this.observedAt;
      this.tasks.set(taskId, next);
      try {
        await this.changed();
      } catch (error) {
        this.tasks.set(taskId, current);
        this.revision = beforeRevision;
        this.observedAt = beforeObservedAt;
        throw error;
      }
      return structuredClone(next);
    });
  }

  subscribe(listener: (snapshot: PetLongTaskSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  flush(): Promise<void> {
    return Promise.all([this.mutationQueue, this.writeQueue]).then(() => undefined);
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.mutationQueue.then(operation);
    this.mutationQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async changed(): Promise<void> {
    this.trim();
    this.revision += 1;
    this.observedAt = this.now();
    const snapshot = this.fileSnapshot();
    const persisted = this.writeQueue.then(() => this.persist(snapshot));
    this.writeQueue = persisted.catch(() => undefined);
    await persisted;
    const publicSnapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(publicSnapshot);
  }

  private trim(): void {
    if (this.tasks.size <= MAX_STORED_TASKS) return;
    const active = [...this.tasks.values()].filter(isActive);
    const terminal = [...this.tasks.values()]
      .filter((task) => !isActive(task))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, Math.max(0, MAX_STORED_TASKS - active.length));
    this.tasks.clear();
    for (const task of [...active, ...terminal]) this.tasks.set(task.id, task);
  }

  private fileSnapshot(): PetLongTaskFile {
    return {
      version: PET_LONG_TASK_SCHEMA_VERSION,
      revision: this.revision,
      observedAt: this.observedAt,
      tasks: [...this.tasks.values()].map((task) => structuredClone(task)),
    };
  }

  private async persist(snapshot: PetLongTaskFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      await rename(temporary, this.filePath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

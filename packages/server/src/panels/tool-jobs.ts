import { createHash, randomUUID } from "node:crypto";
import { opendir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { ToolJobStorage, toolJobJson } from "./tool-jobs-storage.js";

export const toolJobLimits = Object.freeze({
  maxJobs: 2000,
  maxQueuedPerScope: 32,
  maxConcurrent: 2,
  maxInputBytes: 2 * 1024 * 1024 + 8 * 1024,
  maxResultBytes: 2 * 1024 * 1024,
  maxRecordBytes: 4 * 1024 * 1024 + 32 * 1024,
  maxProgressBytes: 4 * 1024,
  maxExaminedEntries: 4096,
});
export interface ToolJobScope {
  appId: string;
  projectPath: string;
  revision: string;
}
export interface ToolJobEntry {
  name: string;
  sha256: string;
}
export interface ToolJobProgress {
  fraction?: number;
  stage?: string;
  message?: string;
}
export type ToolJobStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface ToolJob {
  id: string;
  scope: ToolJobScope;
  entry: ToolJobEntry;
  input: unknown;
  recovery: "manual" | "retry";
  status: ToolJobStatus;
  attempt: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  sequence: number;
  progress?: ToolJobProgress;
  error?: { code: string; message: string; retryable: boolean };
  result?: unknown;
}
export interface ToolJobRequest {
  entry: ToolJobEntry;
  input: unknown;
  recovery: "manual" | "retry";
  requestKey?: string;
}
export interface ToolJobContext {
  workDir: string;
  signal: AbortSignal;
  reportProgress(progress: ToolJobProgress): Promise<void>;
}
export interface PanelToolJobServiceOptions {
  rootDir: string;
  /** Must settle only after the actual native process exits, including on abort. */
  execute(job: ToolJob, context: ToolJobContext): Promise<unknown>;
  /** Freeze authorized inputs into workDir; persist only relative names and safe JSON. */
  prepareInput?(
    scope: ToolJobScope,
    input: unknown,
    workDir: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  isAuthorized?(scope: ToolJobScope): boolean | Promise<boolean>;
  onEvent?(job: ToolJob): void;
  now?: () => number;
}
interface StoredJob extends ToolJob {
  version: 1;
  requestKey?: string;
  requestDigest: string;
}
interface ActiveJob {
  controller: AbortController;
  done: Promise<void>;
}
const TERMINAL = new Set<ToolJobStatus>(["succeeded", "failed", "cancelled", "interrupted"]);
const STATUSES = new Set<ToolJobStatus>([...TERMINAL, "queued", "running", "cancelling"]);

function scopeValue(scope: ToolJobScope): ToolJobScope {
  if (
    !scope ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(scope.appId) ||
    typeof scope.projectPath !== "string" ||
    !isAbsolute(scope.projectPath) ||
    scope.projectPath.length > 4096 ||
    scope.projectPath.includes("\0") ||
    typeof scope.revision !== "string" ||
    !/^[a-zA-Z0-9._-]{1,128}$/.test(scope.revision)
  )
    throw new Error("tool jobs require a Host-bound app, workspace and revision");
  return { appId: scope.appId, projectPath: resolve(scope.projectPath), revision: scope.revision };
}
function sameScope(a: ToolJobScope, b: ToolJobScope, revision = true): boolean {
  return (
    a.appId === b.appId &&
    a.projectPath === b.projectPath &&
    (!revision || a.revision === b.revision)
  );
}
function entryValue(entry: ToolJobEntry): ToolJobEntry {
  if (
    !entry ||
    typeof entry.name !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/.test(entry.name) ||
    typeof entry.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(entry.sha256)
  )
    throw new Error("invalid reviewed tool job entry");
  return { name: entry.name, sha256: entry.sha256 };
}
function progressValue(progress: ToolJobProgress): ToolJobProgress {
  if (!progress || typeof progress !== "object" || Array.isArray(progress))
    throw new Error("invalid tool job progress");
  if (
    progress.fraction !== undefined &&
    (!Number.isFinite(progress.fraction) || progress.fraction < 0 || progress.fraction > 1)
  )
    throw new Error("invalid tool job progress fraction");
  for (const [name, limit] of [
    ["stage", 100],
    ["message", 1000],
  ] as const)
    if (
      progress[name] !== undefined &&
      (typeof progress[name] !== "string" || progress[name]!.length > limit)
    )
      throw new Error("invalid tool job progress text");
  return toolJobJson(
    {
      ...(progress.fraction === undefined ? {} : { fraction: progress.fraction }),
      ...(progress.stage === undefined ? {} : { stage: progress.stage }),
      ...(progress.message === undefined ? {} : { message: progress.message }),
    },
    toolJobLimits.maxProgressBytes,
  );
}
function publicJob(job: StoredJob): ToolJob {
  const {
    version: _version,
    requestKey: _requestKey,
    requestDigest: _requestDigest,
    ...value
  } = job;
  return toolJobJson(value, toolJobLimits.maxRecordBytes);
}
function storedValue(raw: unknown): StoredJob {
  const job = toolJobJson(raw, toolJobLimits.maxRecordBytes) as StoredJob;
  if (
    !job ||
    job.version !== 1 ||
    !/^[a-f0-9-]{36}$/.test(job.id) ||
    !STATUSES.has(job.status) ||
    !Number.isSafeInteger(job.attempt) ||
    job.attempt < 0 ||
    !Number.isSafeInteger(job.sequence) ||
    job.sequence < 0 ||
    !["manual", "retry"].includes(job.recovery) ||
    !/^[a-f0-9]{64}$/.test(job.requestDigest) ||
    !Number.isFinite(job.createdAt) ||
    !Number.isFinite(job.updatedAt)
  )
    throw new Error("invalid tool job record");
  job.scope = scopeValue(job.scope);
  job.entry = entryValue(job.entry);
  job.input = toolJobJson(job.input, toolJobLimits.maxInputBytes);
  if (job.result !== undefined) job.result = toolJobJson(job.result, toolJobLimits.maxResultBytes);
  if (job.progress) job.progress = progressValue(job.progress);
  if (
    job.error &&
    (typeof job.error.code !== "string" ||
      job.error.code.length > 100 ||
      typeof job.error.message !== "string" ||
      job.error.message.length > 2000 ||
      typeof job.error.retryable !== "boolean")
  )
    throw new Error("invalid tool job error");
  return job;
}

/** Durable generic orchestration. Native entry verification and execution are Host-injected. */
export class PanelToolJobService {
  private readonly storage: ToolJobStorage;
  private readonly jobs = new Map<string, StoredJob>();
  private readonly active = new Map<string, ActiveJob>();
  private readonly preparing = new Map<
    string,
    { scope: ToolJobScope; controller: AbortController; done: Promise<void> }
  >();
  private ready?: Promise<void>;
  private serial: Promise<unknown> = Promise.resolve();
  private stopping = false;
  private pumping = false;
  private shutdownPromise?: Promise<void>;

  constructor(private readonly options: PanelToolJobServiceOptions) {
    this.storage = new ToolJobStorage(options.rootDir);
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.serial.then(operation);
    this.serial = pending.catch(() => {});
    return pending;
  }
  private async authorize(scope: ToolJobScope): Promise<void> {
    if (this.options.isAuthorized && !(await this.options.isAuthorized(scope)))
      throw new Error("tool job owner is no longer authorized");
  }
  initialize(): Promise<void> {
    return (this.ready ??= this.load());
  }
  private async load(): Promise<void> {
    await this.storage.initialize();
    try {
      const listing = await opendir(await this.storage.directory());
      let examined = 0;
      for await (const item of listing) {
        if (++examined > toolJobLimits.maxExaminedEntries)
          throw new Error("tool job storage entry limit exceeded");
        if (!item.isDirectory() || !/^[a-f0-9-]{36}$/.test(item.name)) continue;
        let job: StoredJob;
        try {
          const directory = await this.storage.directory(item.name);
          job = storedValue(
            await this.storage.read(join(directory, "job.json"), toolJobLimits.maxRecordBytes),
          );
          if (job.id !== item.name) continue;
        } catch {
          continue; /* One partial or invalid record cannot prevent other recovery. */
        }
        if (this.jobs.size >= toolJobLimits.maxJobs)
          throw new Error("tool job record limit exceeded");
        if (!TERMINAL.has(job.status)) {
          job.status = "interrupted";
          job.updatedAt = job.completedAt = this.now();
          job.sequence++;
          job.error = {
            code: "HOST_INTERRUPTED",
            message: "The previous Host stopped before this task completed.",
            retryable: job.recovery === "retry",
          };
          await this.storage.write(job.id, job, toolJobLimits.maxRecordBytes);
        }
        this.jobs.set(job.id, job);
      }
    } catch (error) {
      await this.storage.close();
      throw error;
    }
  }
  private async commit(job: StoredJob): Promise<void> {
    job.updatedAt = this.now();
    job.sequence++;
    await this.storage.write(job.id, job, toolJobLimits.maxRecordBytes);
    this.jobs.set(job.id, job);
    try {
      this.options.onEvent?.(publicJob(job));
    } catch {
      /* A caller may reconnect via list/get. */
    }
  }
  private lookup(scope: ToolJobScope, id: string, mutate = false): StoredJob {
    if (typeof id !== "string") throw new Error("tool job ID is required");
    const job = this.jobs.get(id);
    if (!job || !sameScope(job.scope, scope, false))
      throw new Error("tool job does not belong to this app and workspace");
    if (mutate && !sameScope(job.scope, scope))
      throw new Error("old-revision tool jobs are read-only; create a new compatible task");
    return job;
  }
  async list(rawScope: ToolJobScope): Promise<Array<ToolJob & { readOnly: boolean }>> {
    const scope = scopeValue(rawScope);
    await this.initialize();
    await this.authorize(scope);
    return [...this.jobs.values()]
      .filter((job) => sameScope(job.scope, scope, false))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((job) => ({ ...publicJob(job), readOnly: job.scope.revision !== scope.revision }));
  }
  async get(rawScope: ToolJobScope, id: string): Promise<ToolJob & { readOnly: boolean }> {
    const scope = scopeValue(rawScope);
    await this.initialize();
    await this.authorize(scope);
    const job = this.lookup(scope, id);
    return { ...publicJob(job), readOnly: job.scope.revision !== scope.revision };
  }
  async start(rawScope: ToolJobScope, request: ToolJobRequest): Promise<ToolJob> {
    const scope = scopeValue(rawScope);
    const entry = entryValue(request?.entry);
    if (!["manual", "retry"].includes(request.recovery))
      throw new Error("tool job recovery must be manual or retry");
    if (
      request.requestKey !== undefined &&
      (typeof request.requestKey !== "string" ||
        !request.requestKey ||
        request.requestKey.length > 160)
    )
      throw new Error("invalid tool job request key");
    const input = toolJobJson(request.input, toolJobLimits.maxInputBytes);
    request = {
      entry,
      input,
      recovery: request.recovery,
      ...(request.requestKey === undefined ? {} : { requestKey: request.requestKey }),
    };
    const requestDigest = createHash("sha256")
      .update(JSON.stringify({ entry, input, recovery: request.recovery }))
      .digest("hex");
    await this.initialize();
    await this.authorize(scope);
    let done!: () => void;
    const reservation = await this.exclusive(async () => {
      if (this.stopping) throw new Error("tool job service is shutting down");
      if (request.requestKey) {
        const existing = [...this.jobs.values()].find(
          (job) => sameScope(job.scope, scope) && job.requestKey === request.requestKey,
        );
        if (existing) {
          if (existing.requestDigest !== requestDigest)
            throw new Error("tool job request key was already used for different input");
          return { existing };
        }
      }
      while (this.jobs.size + this.preparing.size >= toolJobLimits.maxJobs) {
        const oldest = [...this.jobs.values()]
          .filter((job) => TERMINAL.has(job.status) && !this.active.has(job.id))
          .sort((a, b) => (a.completedAt ?? a.updatedAt) - (b.completedAt ?? b.updatedAt))[0];
        if (!oldest) throw new Error("tool job capacity reached with unfinished tasks");
        await this.storage.remove(oldest.id);
        this.jobs.delete(oldest.id);
      }
      const pending =
        [...this.jobs.values()].filter(
          (job) => sameScope(job.scope, scope) && !TERMINAL.has(job.status),
        ).length + [...this.preparing.values()].filter((job) => sameScope(job.scope, scope)).length;
      if (pending >= toolJobLimits.maxQueuedPerScope)
        throw new Error("too many queued tool jobs for this workspace");
      const id = randomUUID();
      const controller = new AbortController();
      this.preparing.set(id, {
        scope,
        controller,
        done: new Promise<void>((resolve) => {
          done = resolve;
        }),
      });
      return { id, controller };
    });
    if (reservation.existing) return publicJob(reservation.existing);
    const { id, controller } = reservation;
    try {
      const workDir = await this.storage.directory(id!, true, true);
      const prepared = this.options.prepareInput
        ? await this.options.prepareInput(scope, input, workDir, controller!.signal)
        : input;
      const job: StoredJob = {
        version: 1,
        id: id!,
        scope,
        entry,
        input: toolJobJson(prepared, toolJobLimits.maxInputBytes),
        recovery: request.recovery,
        status: "queued",
        attempt: 0,
        createdAt: this.now(),
        updatedAt: this.now(),
        sequence: 0,
        ...(request.requestKey === undefined ? {} : { requestKey: request.requestKey }),
        requestDigest,
      };
      await this.authorize(scope);
      await this.exclusive(async () => {
        if (this.stopping || controller!.signal.aborted)
          throw new Error("tool job input preparation was interrupted");
        if (
          request.requestKey &&
          [...this.jobs.values()].some(
            (other) => sameScope(other.scope, scope) && other.requestKey === request.requestKey,
          )
        )
          throw new Error("tool job request key is already being prepared");
        await this.commit(job);
      });
      this.schedule();
      return publicJob(job);
    } catch (error) {
      const path = await this.storage.directory(id!).catch(() => undefined);
      if (path && !this.jobs.has(id!)) await this.storage.remove(id!);
      throw error;
    } finally {
      this.preparing.delete(id!);
      done();
    }
  }
  private schedule(): void {
    if (this.pumping || this.stopping) return;
    this.pumping = true;
    queueMicrotask(() => {
      void this.pump().then(
        () => {
          this.pumping = false;
          if (
            !this.stopping &&
            this.active.size < toolJobLimits.maxConcurrent &&
            [...this.jobs.values()].some((job) => job.status === "queued")
          )
            this.schedule();
        },
        () => {
          this.pumping = false;
        },
      );
    });
  }
  private async pump(): Promise<void> {
    while (!this.stopping && this.active.size < toolJobLimits.maxConcurrent) {
      const selected = await this.exclusive(async () => {
        if (this.stopping) return;
        const current = [...this.jobs.values()].find((job) => job.status === "queued");
        if (!current) return;
        const job = structuredClone(current);
        job.status = "running";
        job.attempt++;
        job.startedAt = this.now();
        delete job.completedAt;
        delete job.error;
        delete job.result;
        delete job.progress;
        const controller = new AbortController();
        let finish!: () => void;
        const done = new Promise<void>((resolve) => {
          finish = resolve;
        });
        await this.commit(job);
        this.active.set(job.id, { controller, done });
        return { job, controller, finish };
      });
      if (!selected) return;
      void this.run(selected.job, selected.controller)
        .finally(() => {
          this.active.delete(selected.job.id);
          selected.finish();
          this.schedule();
        })
        .catch(() => {});
    }
  }
  private async run(job: StoredJob, controller: AbortController): Promise<void> {
    let result: unknown;
    let failure: unknown;
    try {
      await this.authorize(job.scope);
      if (this.stopping) controller.abort();
      if (controller.signal.aborted) throw new Error("tool job cancelled before execution");
      result = toolJobJson(
        (await this.options.execute(publicJob(job), {
          workDir: await this.storage.directory(job.id, true),
          signal: controller.signal,
          reportProgress: async (progress) => {
            const value = progressValue(progress);
            if (controller.signal.aborted) return;
            await this.exclusive(async () => {
              const current = this.jobs.get(job.id)!;
              if (current.status !== "running" || controller.signal.aborted) return;
              const next = structuredClone(current);
              next.progress = { ...next.progress, ...value };
              await this.commit(next);
            });
          },
        })) ?? null,
        toolJobLimits.maxResultBytes,
      );
    } catch (error) {
      failure = error;
    }
    await this.exclusive(async () => {
      const next = structuredClone(this.jobs.get(job.id)!);
      next.completedAt = this.now();
      if (this.stopping || controller.signal.aborted) {
        next.status = this.stopping ? "interrupted" : "cancelled";
        if (next.error?.code !== "APP_REVOKED")
          next.error = {
            code: this.stopping ? "HOST_INTERRUPTED" : "CANCELLED",
            message: this.stopping ? "Host stopped this task." : "Task was cancelled.",
            retryable: next.recovery === "retry",
          };
      } else if (failure !== undefined) {
        const details = failure as { code?: unknown; retryable?: unknown };
        next.status = "failed";
        next.error = {
          code: typeof details?.code === "string" ? details.code.slice(0, 100) : "TOOL_FAILED",
          message: String(failure instanceof Error ? failure.message : failure).slice(0, 2000),
          retryable: next.recovery === "retry" && details?.retryable !== false,
        };
      } else {
        next.status = "succeeded";
        next.result = result;
        next.progress = { ...next.progress, fraction: 1 };
      }
      await this.commit(next);
    });
  }
  async cancel(rawScope: ToolJobScope, id: string): Promise<ToolJob> {
    const scope = scopeValue(rawScope);
    await this.initialize();
    await this.authorize(scope);
    let active: ActiveJob | undefined;
    await this.exclusive(async () => {
      const current = this.lookup(scope, id, true);
      if (TERMINAL.has(current.status)) return;
      const next = structuredClone(current);
      active = this.active.get(id);
      next.status = active ? "cancelling" : "cancelled";
      if (!active) {
        next.completedAt = this.now();
        next.error = {
          code: "CANCELLED",
          message: "Task was cancelled before execution.",
          retryable: next.recovery === "retry",
        };
      }
      await this.commit(next);
      active?.controller.abort();
    });
    await active?.done;
    return publicJob(this.lookup(scope, id, true));
  }
  async retry(rawScope: ToolJobScope, id: string): Promise<ToolJob> {
    const scope = scopeValue(rawScope);
    await this.initialize();
    await this.authorize(scope);
    const job = await this.exclusive(async () => {
      if (this.stopping) throw new Error("tool job service is shutting down");
      const current = this.lookup(scope, id, true);
      if (this.active.has(id) || !["failed", "cancelled", "interrupted"].includes(current.status))
        throw new Error("tool job must finish stopping before retry");
      if (current.recovery !== "retry" || !current.error?.retryable)
        throw new Error("tool job requires a new manually reviewed request");
      const next = structuredClone(current);
      next.status = "queued";
      delete next.error;
      delete next.completedAt;
      delete next.result;
      delete next.progress;
      await this.commit(next);
      return publicJob(next);
    });
    this.schedule();
    return job;
  }
  async cancelApp(appId: string): Promise<void> {
    await this.initialize();
    for (const item of this.preparing.values())
      if (item.scope.appId === appId) item.controller.abort();
    const matching = [...this.jobs.values()].filter(
      (job) => job.scope.appId === appId && !TERMINAL.has(job.status),
    );
    // Revocation bypasses the now-revoked caller grant but still waits for real exits.
    await this.exclusive(async () => {
      for (const current of matching) {
        const job = structuredClone(this.jobs.get(current.id)!);
        if (TERMINAL.has(job.status)) continue;
        const active = this.active.get(job.id);
        job.status = active ? "cancelling" : "cancelled";
        job.error = {
          code: "APP_REVOKED",
          message: "The app authorization was revoked.",
          retryable: false,
        };
        if (!active) {
          job.completedAt = this.now();
        }
        await this.commit(job);
        active?.controller.abort();
      }
    });
    await Promise.all(matching.flatMap((job) => this.active.get(job.id)?.done ?? []));
  }
  shutdown(): Promise<void> {
    return (this.shutdownPromise ??= this.stop());
  }
  private async stop(): Promise<void> {
    this.stopping = true;
    await this.initialize();
    // Flush admissions that were already persisting when shutdown began.
    await this.exclusive(async () => {});
    for (const item of this.preparing.values()) item.controller.abort();
    for (const item of this.active.values()) item.controller.abort();
    await Promise.all([...this.preparing.values()].map((item) => item.done));
    await Promise.all([...this.active.values()].map((item) => item.done));
    await this.exclusive(async () => {
      for (const current of this.jobs.values()) {
        if (TERMINAL.has(current.status)) continue;
        const job = structuredClone(current);
        job.status = "interrupted";
        job.completedAt = this.now();
        job.error = {
          code: "HOST_INTERRUPTED",
          message: "Host stopped before this task completed.",
          retryable: job.recovery === "retry",
        };
        await this.commit(job);
      }
    });
    await this.storage.close();
  }
}

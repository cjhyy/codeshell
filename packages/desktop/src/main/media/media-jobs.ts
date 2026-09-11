import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  cloneMediaJson,
  mediaDirectory,
  mediaScopeKey,
  normalizeMediaScope,
  readMediaJson,
  writeMediaJson,
} from "./media-storage.js";
import type {
  MediaJob,
  MediaJobError,
  MediaJobProcessor,
  MediaJobProgress,
  MediaJobStatus,
  MediaScope,
} from "./media-types.js";

const JOB_ID = /^job-[a-zA-Z0-9-]{1,100}$/;
const PROCESSOR_ID = /^[a-z][a-z0-9.-]{0,63}$/;
const MAX_JOB_RESULT_BYTES = 192 * 1024;
const TERMINAL = new Set<MediaJobStatus>(["succeeded", "failed", "cancelled"]);

interface StoredJob extends MediaJob {
  schemaVersion: 1;
  scope: MediaScope;
  input: unknown;
  idempotencyKey?: string;
}

export interface MediaJobStartInput {
  type: string;
  input: unknown;
  idempotencyKey?: string;
  /** Reanalysis reuses pending work, then lets the processor validate its own cache. */
  idempotencyPolicy?: "all" | "active";
}

export interface MediaJobServiceOptions {
  rootDirectory: string;
  concurrency?: number;
  maxJobs?: number;
  now?: () => number;
  makeId?: () => string;
  onChanged?: (scope: MediaScope, job: MediaJob) => void;
  onRecoveryError?: (issue: { path: string; message: string }) => void;
}

function publicJob(job: StoredJob, includeResult = true): MediaJob {
  const {
    schemaVersion: _version,
    scope: _scope,
    input: _input,
    idempotencyKey: _key,
    ...view
  } = job;
  if (includeResult) return cloneMediaJson(view);
  const { result: _result, ...summary } = view;
  return cloneMediaJson(summary);
}

function progressValue(value: MediaJobProgress): MediaJobProgress {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid media progress");
  if (
    value.fraction !== undefined &&
    (!Number.isFinite(value.fraction) || value.fraction < 0 || value.fraction > 1)
  )
    throw new Error("Media progress fraction must be between 0 and 1");
  if (value.stage !== undefined && (typeof value.stage !== "string" || value.stage.length > 80))
    throw new Error("Invalid media progress stage");
  if (
    value.message !== undefined &&
    (typeof value.message !== "string" || value.message.length > 1000)
  )
    throw new Error("Invalid media progress message");
  return {
    ...(value.fraction !== undefined ? { fraction: value.fraction } : {}),
    ...(value.stage !== undefined ? { stage: value.stage } : {}),
    ...(value.message !== undefined ? { message: value.message } : {}),
  };
}

function storedJob(value: unknown, id: string, scopeKey: string): StoredJob {
  const job = value as StoredJob | null;
  if (
    !job ||
    job.schemaVersion !== 1 ||
    job.id !== id ||
    !JOB_ID.test(job.id) ||
    !PROCESSOR_ID.test(job.type) ||
    !["queued", "running", ...TERMINAL].includes(job.status) ||
    !Number.isSafeInteger(job.attempt) ||
    job.attempt < 0 ||
    !Number.isSafeInteger(job.createdAt) ||
    !Number.isSafeInteger(job.updatedAt) ||
    mediaScopeKey(job.scope) !== scopeKey
  )
    throw new Error("Invalid stored media job");
  const fields = [
    "schemaVersion",
    "id",
    "type",
    "status",
    "attempt",
    "createdAt",
    "updatedAt",
    "completedAt",
    "progress",
    "result",
    "error",
    "scope",
    "input",
    "idempotencyKey",
  ];
  if (Object.keys(job).some((key) => !fields.includes(key)))
    throw new Error("Unknown stored media job field");
  if (job.progress) job.progress = progressValue(job.progress);
  if (
    job.error &&
    (typeof job.error.code !== "string" ||
      job.error.code.length > 80 ||
      typeof job.error.message !== "string" ||
      job.error.message.length > 2000 ||
      typeof job.error.retryable !== "boolean")
  )
    throw new Error("Invalid stored media error");
  if (job.result !== undefined) cloneMediaJson(job.result, MAX_JOB_RESULT_BYTES);
  if (
    job.idempotencyKey !== undefined &&
    (typeof job.idempotencyKey !== "string" || job.idempotencyKey.length > 128)
  )
    throw new Error("Invalid stored idempotency key");
  return cloneMediaJson(job);
}

/** Durable Host jobs are deliberately not owned by webContents/guest lifetimes. */
export class MediaJobService {
  private readonly options: MediaJobServiceOptions;
  private readonly processors = new Map<string, MediaJobProcessor>();
  private readonly jobs = new Map<string, StoredJob>();
  private readonly active = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private readonly writes = new Map<string, Promise<unknown>>();
  private readonly recoveryIssues: { path: string; message: string }[] = [];
  private initialization?: Promise<void>;
  private startQueue: Promise<unknown> = Promise.resolve();
  private stopping = false;
  private pumping = false;

  constructor(options: MediaJobServiceOptions) {
    this.options = { concurrency: 2, maxJobs: 2000, now: Date.now, makeId: randomUUID, ...options };
    if (
      !Number.isSafeInteger(this.options.concurrency) ||
      this.options.concurrency! < 1 ||
      this.options.concurrency! > 16
    )
      throw new Error("Invalid media job concurrency");
    if (!Number.isSafeInteger(this.options.maxJobs) || this.options.maxJobs! < 1)
      throw new Error("Invalid media job limit");
  }

  registerProcessor(type: string, processor: MediaJobProcessor): () => void {
    if (!PROCESSOR_ID.test(type) || typeof processor?.run !== "function")
      throw new Error("Invalid media processor");
    if (this.processors.has(type)) throw new Error(`Media processor already registered: ${type}`);
    if (processor.recovery !== undefined && !["fail", "restart"].includes(processor.recovery))
      throw new Error("Invalid media recovery policy");
    this.processors.set(type, processor);
    return () => {
      if (this.processors.get(type) === processor) this.processors.delete(type);
    };
  }

  getRecoveryIssues(): { path: string; message: string }[] {
    return structuredClone(this.recoveryIssues);
  }

  initialize(): Promise<void> {
    this.initialization ??= this.restore();
    return this.initialization;
  }

  private now(): number {
    return this.options.now!();
  }
  private key(scope: MediaScope, id: string): string {
    if (!JOB_ID.test(id)) throw new Error("Invalid media job ID");
    return `${mediaScopeKey(scope)}:${id}`;
  }
  private async directory(job: StoredJob): Promise<string> {
    return mediaDirectory(this.options.rootDirectory, [
      "scopes",
      mediaScopeKey(job.scope),
      "jobs",
      job.id,
    ]);
  }
  private async persist(job: StoredJob): Promise<void> {
    await writeMediaJson(join(await this.directory(job), "job.json"), job);
  }
  private emit(job: StoredJob): void {
    try {
      this.options.onChanged?.(structuredClone(job.scope), publicJob(job));
    } catch {
      /* Guest teardown must not fail a job. */
    }
  }
  private issue(path: string, error: unknown): void {
    const issue = {
      path,
      message: String(error instanceof Error ? error.message : error).slice(0, 1000),
    };
    this.recoveryIssues.push(issue);
    try {
      this.options.onRecoveryError?.(issue);
    } catch {
      /* Preserve recovery of unrelated jobs. */
    }
  }

  private async restore(): Promise<void> {
    const scopes = await mediaDirectory(this.options.rootDirectory, ["scopes"]);
    for (const scopeEntry of await readdir(scopes, { withFileTypes: true })) {
      if (!/^[a-f0-9]{64}$/.test(scopeEntry.name)) continue;
      let directory: string;
      try {
        directory = await mediaDirectory(
          this.options.rootDirectory,
          ["scopes", scopeEntry.name, "jobs"],
          false,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          this.issue(join(scopes, scopeEntry.name), error);
        continue;
      }
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!JOB_ID.test(entry.name)) continue;
        const path = join(directory, entry.name, "job.json");
        try {
          if (this.jobs.size >= this.options.maxJobs!)
            throw new Error("Stored media job limit exceeded");
          await mediaDirectory(
            this.options.rootDirectory,
            ["scopes", scopeEntry.name, "jobs", entry.name],
            false,
          );
          const job = storedJob(await readMediaJson(path), entry.name, scopeEntry.name);
          if (job.status === "running") {
            if (this.processors.get(job.type)?.recovery === "restart") {
              job.status = "queued";
              delete job.progress;
            } else {
              job.status = "failed";
              job.completedAt = this.now();
              job.error = {
                code: "INTERRUPTED",
                message:
                  "The Host stopped while this job was running. Retry explicitly to run it again.",
                retryable: true,
              };
            }
            job.updatedAt = this.now();
            await this.persist(job);
          }
          this.jobs.set(this.key(job.scope, job.id), job);
          this.emit(job);
        } catch (error) {
          this.issue(path, error);
        }
      }
    }
    this.schedule();
  }

  private update(key: string, change: (job: StoredJob) => void): Promise<MediaJob> {
    const operation = (this.writes.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const previous = this.jobs.get(key);
        if (!previous) throw new Error("Media job not found in this app and project");
        const next = cloneMediaJson(previous);
        change(next);
        next.updatedAt = this.now();
        await this.persist(next);
        this.jobs.set(key, next);
        this.emit(next);
        return publicJob(next);
      });
    this.writes.set(key, operation);
    void operation
      .finally(() => {
        if (this.writes.get(key) === operation) this.writes.delete(key);
      })
      .catch(() => {});
    return operation;
  }

  async start(scope: MediaScope, input: MediaJobStartInput): Promise<MediaJob> {
    await this.initialize();
    const boundScope = normalizeMediaScope(scope);
    if (this.stopping) throw new Error("Media service is shutting down");
    if (!PROCESSOR_ID.test(input?.type) || !this.processors.has(input.type))
      throw new Error("Media processor is unavailable");
    if (
      input.idempotencyKey !== undefined &&
      (typeof input.idempotencyKey !== "string" ||
        !input.idempotencyKey ||
        input.idempotencyKey.length > 128)
    )
      throw new Error("Invalid media idempotency key");
    if (
      input.idempotencyPolicy !== undefined &&
      !["all", "active"].includes(input.idempotencyPolicy)
    )
      throw new Error("Invalid media idempotency policy");
    const snapshot = cloneMediaJson(input.input);
    const type = input.type;
    const idempotencyKey = input.idempotencyKey;
    const idempotencyPolicy = input.idempotencyPolicy ?? "all";
    const operation = this.startQueue
      .catch(() => {})
      .then(async () => {
        if (this.stopping) throw new Error("Media service is shutting down");
        if (idempotencyKey) {
          const existing = [...this.jobs.values()].find(
            (job) =>
              mediaScopeKey(job.scope) === mediaScopeKey(boundScope) &&
              job.idempotencyKey === idempotencyKey &&
              (idempotencyPolicy === "all" || !TERMINAL.has(job.status)),
          );
          if (existing) {
            if (
              existing.type !== type ||
              JSON.stringify(existing.input) !== JSON.stringify(snapshot)
            )
              throw new Error("Idempotency key is already bound to a different media operation");
            return publicJob(existing);
          }
        }
        if (this.jobs.size >= this.options.maxJobs!)
          throw new Error("Media job history limit reached");
        const id = `job-${this.options.makeId!()}`;
        const key = this.key(boundScope, id);
        if (this.jobs.has(key)) throw new Error("Duplicate media job ID");
        const job: StoredJob = {
          schemaVersion: 1,
          id,
          scope: boundScope,
          type,
          input: snapshot,
          status: "queued",
          attempt: 0,
          createdAt: this.now(),
          updatedAt: this.now(),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        };
        await this.persist(job);
        this.jobs.set(key, job);
        this.emit(job);
        this.schedule();
        return publicJob(job);
      });
    this.startQueue = operation;
    return operation;
  }

  async get(scope: MediaScope, id: string): Promise<MediaJob> {
    await this.initialize();
    const job = this.jobs.get(this.key(scope, id));
    if (!job) throw new Error("Media job not found in this app and project");
    return publicJob(job);
  }

  async list(scope: MediaScope, options: { includeResult?: boolean } = {}): Promise<MediaJob[]> {
    await this.initialize();
    const key = mediaScopeKey(scope);
    return [...this.jobs.values()]
      .filter((job) => mediaScopeKey(job.scope) === key)
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      .map((job) => publicJob(job, options.includeResult !== false));
  }

  async cancel(scope: MediaScope, id: string): Promise<MediaJob> {
    await this.get(scope, id);
    const key = this.key(scope, id);
    const view = await this.update(key, (job) => {
      if (TERMINAL.has(job.status)) return;
      job.status = "cancelled";
      job.completedAt = this.now();
      delete job.error;
    });
    if (view.status === "cancelled") this.active.get(key)?.controller.abort();
    return view;
  }

  /** Host revocation reaches durable jobs even after their last guest has closed. */
  async cancelApp(appId: string): Promise<void> {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(appId)) throw new Error("Invalid media app ID");
    await this.initialize();
    await Promise.all(
      [...this.jobs.values()]
        .filter((job) => job.scope.appId === appId && !TERMINAL.has(job.status))
        .map((job) => this.cancel(job.scope, job.id)),
    );
  }

  async retry(scope: MediaScope, id: string): Promise<MediaJob> {
    const current = await this.get(scope, id);
    const key = this.key(scope, id);
    if (this.stopping) throw new Error("Media service is shutting down");
    if (this.active.has(key))
      throw new Error("Media job is still stopping; retry after its processor exits");
    if (!["failed", "cancelled"].includes(current.status))
      throw new Error("Only failed or cancelled media jobs can be retried");
    if (!this.processors.has(current.type)) throw new Error("Media processor is unavailable");
    const view = await this.update(key, (job) => {
      if (!["failed", "cancelled"].includes(job.status))
        throw new Error("Media job changed before retry");
      job.status = "queued";
      delete job.completedAt;
      delete job.result;
      delete job.error;
      delete job.progress;
    });
    this.schedule();
    return view;
  }

  private schedule(): void {
    queueMicrotask(() => {
      void this.pump();
    });
  }
  private async pump(): Promise<void> {
    if (this.stopping || this.pumping) return;
    this.pumping = true;
    try {
      while (!this.stopping && this.active.size < this.options.concurrency!) {
        const entry = [...this.jobs.entries()].find(
          ([key, job]) => job.status === "queued" && !this.active.has(key),
        );
        if (!entry) break;
        const [key] = entry;
        const controller = new AbortController();
        const promise = this.run(key, controller)
          .catch((error) => {
            // Storage failures before claiming a queued job must not create an
            // infinite reschedule loop. Preserve its disk record for recovery.
            const job = this.jobs.get(key);
            if (job && !TERMINAL.has(job.status)) {
              job.status = "failed";
              job.completedAt = this.now();
              job.error = {
                code: "STORAGE_FAILED",
                message: String(error).slice(0, 2000),
                retryable: true,
              };
              this.emit(job);
            }
            this.issue(key, error);
          })
          .finally(() => {
            this.active.delete(key);
            this.schedule();
          });
        this.active.set(key, { controller, promise });
      }
    } finally {
      this.pumping = false;
    }
  }

  private async run(key: string, controller: AbortController): Promise<void> {
    const initial = this.jobs.get(key)!;
    const processor = this.processors.get(initial.type);
    if (!processor) {
      await this.update(key, (job) => {
        if (job.status !== "queued") return;
        job.status = "failed";
        job.completedAt = this.now();
        job.error = {
          code: "PROCESSOR_UNAVAILABLE",
          message: "The registered media processor is unavailable.",
          retryable: true,
        };
      });
      return;
    }
    const started = await this.update(key, (job) => {
      if (job.status !== "queued" || this.stopping) return;
      job.status = "running";
      job.attempt += 1;
      delete job.error;
      delete job.result;
    });
    if (started.status !== "running" || this.stopping) return;
    try {
      const job = this.jobs.get(key)!;
      const segments = [
        "scopes",
        mediaScopeKey(job.scope),
        "jobs",
        job.id,
        `attempt-${job.attempt}`,
      ];
      const workDir = await mediaDirectory(this.options.rootDirectory, segments);
      const outputDir = await mediaDirectory(this.options.rootDirectory, [...segments, "output"]);
      const cacheDir = await mediaDirectory(this.options.rootDirectory, [
        "scopes",
        mediaScopeKey(job.scope),
        "cache",
        job.type,
      ]);
      const result = await processor.run(cloneMediaJson(job.input), {
        scope: structuredClone(job.scope),
        jobId: job.id,
        attempt: job.attempt,
        signal: controller.signal,
        workDir,
        outputDir,
        cacheDir,
        reportProgress: async (progress) => {
          const value = progressValue(progress);
          if (this.stopping || controller.signal.aborted) return;
          await this.update(key, (current) => {
            if (current.status !== "running" || current.attempt !== job.attempt) return;
            current.progress = { ...current.progress, ...value };
          });
        },
      });
      if (this.stopping) return;
      const detached = cloneMediaJson(result ?? null, MAX_JOB_RESULT_BYTES);
      await this.update(key, (current) => {
        if (current.status !== "running" || controller.signal.aborted) return;
        current.status = "succeeded";
        current.completedAt = this.now();
        current.result = detached;
        current.progress = { ...current.progress, fraction: 1 };
      });
    } catch (error) {
      if (this.stopping) return;
      const failure: MediaJobError = {
        code: "PROCESSOR_FAILED",
        message: String(error instanceof Error ? error.message : error).slice(0, 2000),
        retryable: true,
      };
      await this.update(key, (job) => {
        if (job.status !== "running") return;
        job.status = controller.signal.aborted ? "cancelled" : "failed";
        job.completedAt = this.now();
        if (!controller.signal.aborted) job.error = failure;
      });
    }
  }

  /** Only call for Host shutdown. Do not connect this to guest/webContents disposal. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    await this.startQueue.catch(() => {});
    for (const active of this.active.values()) active.controller.abort();
    await Promise.allSettled([...this.active.values()].map((active) => active.promise));
    await Promise.allSettled([...this.writes.values()]);
    // Running records deliberately remain running on disk; recovery applies the
    // processor's declared restart policy, never an implicit repeat of work.
  }
}

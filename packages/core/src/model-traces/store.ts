import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  promises as fs,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { deriveModelTraceCallType, isModelTraceCallType } from "./classification.js";
import type {
  ModelTraceConfig,
  ModelTraceConfigPatch,
  ModelTraceEvent,
  ModelTraceListQuery,
  ModelTracePage,
  ModelTraceRecord,
  ModelTraceSessionPage,
  ModelTraceSessionSummary,
  ModelTraceSummary,
} from "./types.js";

export const DEFAULT_MODEL_TRACE_CONFIG: Readonly<ModelTraceConfig> = Object.freeze({
  policyRevision: "defaults-v2",
  enabled: true,
  captureContent: true,
  retentionDays: 7,
  includeEphemeral: true,
});
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_SUMMARY_BYTES = 32 * 1024;
const key = (id: string) => createHash("sha256").update(id).digest("hex");
const retentionDays = (saved: any): number =>
  Number.isSafeInteger(saved?.retentionDays) &&
  saved.retentionDays >= 1 &&
  saved.retentionDays <= 365
    ? saved.retentionDays
    : DEFAULT_MODEL_TRACE_CONFIG.retentionDays;
const statuses = new Set(["running", "completed", "failed", "cancelled"]);

function readJson(file: string, maxBytes: number): any {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return null;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function validId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\0")
  );
}
function summary(record: ModelTraceRecord): ModelTraceSummary {
  const { input: _input, output: _output, attempts, ...metadata } = record;
  return { ...metadata, attemptCount: attempts.length };
}

/** Host-owned local trace store. Readers never open user-provided paths or return keys. */
export class ModelTraceStore {
  readonly storageDir: string;
  private lastPruned = 0;
  private maintenance?: Promise<void>;
  private maintenanceAgain = false;
  private maintenanceWake?: ReturnType<typeof setImmediate>;
  private maintenanceWaiters = 0;
  constructor({ storageDir }: { storageDir: string }) {
    if (typeof storageDir !== "string" || !storageDir || storageDir.includes("\0"))
      throw new Error("Model trace storage directory required");
    this.storageDir = resolve(storageDir);
  }
  getConfig(): ModelTraceConfig {
    const saved = this.directorySafe(this.storageDir)
      ? readJson(join(this.storageDir, "config.json"), 4096)
      : null;
    const savedRevision =
      typeof saved?.policyRevision === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/.test(saved.policyRevision)
        ? saved.policyRevision
        : "initial";
    const currentDefaults = saved?.defaultsVersion === 2;
    // The v2 rollout explicitly enables Prompt and temporary-call recording.
    // Derive a stable generation without a read-time write: processes must agree,
    // while calls started under the old policy must never resume body capture.
    const policyRevision = !saved
      ? DEFAULT_MODEL_TRACE_CONFIG.policyRevision
      : currentDefaults
        ? savedRevision
        : `defaults-v2-${createHash("sha256").update(savedRevision).digest("hex").slice(0, 32)}`;
    return {
      policyRevision,
      enabled: typeof saved?.enabled === "boolean" ? saved.enabled : true,
      captureContent:
        currentDefaults && typeof saved?.captureContent === "boolean" ? saved.captureContent : true,
      includeEphemeral:
        currentDefaults && typeof saved?.includeEphemeral === "boolean"
          ? saved.includeEphemeral
          : true,
      retentionDays: retentionDays(saved),
    };
  }
  setConfig(patch: ModelTraceConfigPatch): ModelTraceConfig {
    if (
      !patch ||
      typeof patch !== "object" ||
      Array.isArray(patch) ||
      Object.keys(patch).some(
        (name) =>
          !["enabled", "captureContent", "retentionDays", "includeEphemeral"].includes(name),
      ) ||
      (patch.enabled !== undefined && typeof patch.enabled !== "boolean") ||
      (patch.captureContent !== undefined && typeof patch.captureContent !== "boolean") ||
      (patch.includeEphemeral !== undefined && typeof patch.includeEphemeral !== "boolean") ||
      (patch.retentionDays !== undefined &&
        (!Number.isSafeInteger(patch.retentionDays) ||
          patch.retentionDays < 1 ||
          patch.retentionDays > 365))
    )
      throw new Error("Invalid model trace configuration");
    const previous = this.getConfig();
    const updates = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as ModelTraceConfigPatch;
    const changed = (["enabled", "captureContent", "includeEphemeral"] as const).some(
      (name) => updates[name] !== undefined && updates[name] !== previous[name],
    );
    const config: ModelTraceConfig = {
      ...previous,
      ...updates,
      policyRevision: changed ? randomUUID() : previous.policyRevision,
    };
    this.writeJson(this.storageDir, "config.json", { ...config, defaultsVersion: 2 });
    this.prune(true);
    return config;
  }
  private matchingSummaries(query: ModelTraceListQuery): ModelTraceSummary[] {
    if (!query || typeof query !== "object" || Array.isArray(query))
      throw new Error("Invalid model trace query");
    const limit = query.limit ?? 50;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500 ||
      (query.status !== undefined && !statuses.has(query.status)) ||
      (query.callType !== undefined && !isModelTraceCallType(query.callType)) ||
      (query.withoutSession !== undefined && typeof query.withoutSession !== "boolean") ||
      [query.since, query.until].some(
        (time) => time !== undefined && (!Number.isFinite(time) || time < 0),
      )
    )
      throw new Error("Invalid model trace query");
    for (const field of [
      "cursor",
      "search",
      "traceId",
      "sessionId",
      "workspacePath",
      "model",
      "provider",
      "purpose",
      "source",
    ] as const)
      if (
        query[field] !== undefined &&
        (typeof query[field] !== "string" ||
          query[field]!.length > 4096 ||
          query[field]!.includes("\0"))
      )
        throw new Error("Invalid model trace query");
    if (query.workspaceScopes !== undefined) {
      if (
        !Array.isArray(query.workspaceScopes) ||
        query.workspaceScopes.length < 1 ||
        query.workspaceScopes.length > 8 ||
        query.workspacePath !== undefined ||
        query.workspaceScopes.some(
          (scope) =>
            !scope ||
            typeof scope !== "object" ||
            Array.isArray(scope) ||
            Object.keys(scope).some(
              (field) => !["workspacePath", "sourcePrefix"].includes(field),
            ) ||
            typeof scope.workspacePath !== "string" ||
            !scope.workspacePath ||
            scope.workspacePath.length > 4096 ||
            scope.workspacePath.includes("\0") ||
            (scope.sourcePrefix !== undefined &&
              (typeof scope.sourcePrefix !== "string" ||
                !scope.sourcePrefix ||
                scope.sourcePrefix.length > 256 ||
                scope.sourcePrefix.includes("\0"))),
        )
      )
        throw new Error("Invalid model trace workspace scopes");
    }
    this.prune();
    const cutoff = Date.now() - this.getConfig().retentionDays * 86_400_000;
    const words = query.search?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    const rows: ModelTraceSummary[] = [];
    for (const name of this.files("summaries")) {
      const row = readJson(join(this.storageDir, "summaries", name), MAX_SUMMARY_BYTES);
      if (
        !row ||
        row.version !== 1 ||
        !validId(row.id) ||
        !validId(row.traceId) ||
        !Number.isFinite(row.startedAt) ||
        row.startedAt < cutoff ||
        !statuses.has(row.status)
      )
        continue;
      const callType = deriveModelTraceCallType(row);
      if (query.callType !== undefined && callType !== query.callType) continue;
      if (query.withoutSession && validId(row.sessionId)) continue;
      if (
        query.workspaceScopes &&
        !query.workspaceScopes.some(
          (scope) =>
            row.workspacePath === scope.workspacePath &&
            (scope.sourcePrefix === undefined ||
              (typeof row.source === "string" && row.source.startsWith(scope.sourcePrefix))),
        )
      )
        continue;
      if (
        [
          "traceId",
          "sessionId",
          "workspacePath",
          "model",
          "provider",
          "purpose",
          "source",
          "status",
        ].some((field) => query[field] !== undefined && row[field] !== query[field])
      )
        continue;
      if (
        (query.since !== undefined && row.startedAt < query.since) ||
        (query.until !== undefined && row.startedAt > query.until)
      )
        continue;
      const haystack = [
        row.id,
        row.traceId,
        row.sessionId,
        row.runId,
        row.provider,
        row.model,
        row.purpose,
        row.source,
        row.error,
      ]
        .join(" ")
        .toLowerCase();
      if (!words.every((word) => haystack.includes(word))) continue;
      rows.push({
        ...Object.fromEntries(
          [
            "version",
            "id",
            "traceId",
            "sessionId",
            "runId",
            "parentSessionId",
            "workspacePath",
            "source",
            "purpose",
            "provider",
            "providerKind",
            "model",
            "startedAt",
            "endedAt",
            "status",
            "stream",
            "inputState",
            "outputState",
            "error",
            "usage",
            "attemptCount",
            "estimatedCostUsd",
            "pricing",
            "unknownCostAttempts",
          ]
            .filter((field) => row[field] !== undefined)
            .map((field) => [field, row[field]]),
        ),
        callType,
      } as unknown as ModelTraceSummary);
    }
    return rows;
  }
  list(query: ModelTraceListQuery = {}): ModelTracePage {
    const rows = this.matchingSummaries(query);
    const limit = query.limit ?? 50;
    rows.sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
    const total = rows.length;
    let after: { startedAt: number; id: string } | undefined;
    if (query.cursor) {
      try {
        after = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
      } catch {
        throw new Error("Invalid model trace cursor");
      }
      if (!after || !Number.isFinite(after.startedAt) || !validId(after.id))
        throw new Error("Invalid model trace cursor");
    }
    const candidates = after
      ? rows.filter(
          (row) =>
            row.startedAt < after!.startedAt ||
            (row.startedAt === after!.startedAt && row.id.localeCompare(after!.id) < 0),
        )
      : rows;
    const items = candidates.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      total,
      ...(candidates.length > limit && last
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({ startedAt: last.startedAt, id: last.id }),
            ).toString("base64url"),
          }
        : {}),
    };
  }
  /** Group matching metadata before pagination; never load Prompt or response bodies. */
  sessions(query: ModelTraceListQuery = {}): ModelTraceSessionPage {
    const rows = this.matchingSummaries(query);
    const groups = new Map<
      string,
      { item: ModelTraceSessionSummary; traces: Set<string>; latestStartedAt: number }
    >();
    for (const row of rows) {
      const sessionId = validId(row.sessionId) ? row.sessionId : undefined;
      const groupKey = sessionId === undefined ? `trace:${row.traceId}` : `session:${sessionId}`;
      const updatedAt =
        row.endedAt !== undefined && Number.isFinite(row.endedAt)
          ? Math.max(row.startedAt, row.endedAt)
          : row.startedAt;
      let group = groups.get(groupKey);
      if (!group) {
        group = {
          item: {
            key: groupKey,
            ...(sessionId === undefined ? { traceId: row.traceId } : { sessionId }),
            latestRequestId: row.id,
            latestTraceId: row.traceId,
            startedAt: row.startedAt,
            updatedAt,
            callCount: 0,
            traceCount: 0,
            sources: [],
            models: [],
            callTypes: [],
            runningCount: 0,
            failedCount: 0,
          },
          traces: new Set(),
          latestStartedAt: row.startedAt,
        };
        groups.set(groupKey, group);
      }
      const item = group.item;
      item.startedAt = Math.min(item.startedAt, row.startedAt);
      item.callCount++;
      group.traces.add(row.traceId);
      if (typeof row.source === "string" && !item.sources.includes(row.source))
        item.sources.push(row.source);
      if (typeof row.model === "string" && !item.models.includes(row.model))
        item.models.push(row.model);
      if (row.callType && !item.callTypes!.includes(row.callType))
        item.callTypes!.push(row.callType);
      if (row.status === "running") item.runningCount++;
      if (row.status === "failed") item.failedCount++;
      if (
        updatedAt > item.updatedAt ||
        (updatedAt === item.updatedAt &&
          (row.startedAt > group.latestStartedAt ||
            (row.startedAt === group.latestStartedAt &&
              row.id.localeCompare(item.latestRequestId) > 0)))
      ) {
        item.updatedAt = updatedAt;
        item.latestRequestId = row.id;
        item.latestTraceId = row.traceId;
        group.latestStartedAt = row.startedAt;
      }
    }
    const items = [...groups.values()].map(({ item, traces }) => ({
      ...item,
      traceCount: traces.size,
      sources: item.sources.sort(),
      models: item.models.sort(),
      callTypes: item.callTypes!.sort(),
    }));
    items.sort((a, b) => b.updatedAt - a.updatedAt || b.key.localeCompare(a.key));
    let after: { kind: "sessions"; updatedAt: number; key: string } | undefined;
    if (query.cursor) {
      try {
        after = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
      } catch {
        throw new Error("Invalid model trace session cursor");
      }
      if (
        !after ||
        after.kind !== "sessions" ||
        !Number.isFinite(after.updatedAt) ||
        after.updatedAt < 0 ||
        typeof after.key !== "string" ||
        !/^(session|trace):./s.test(after.key) ||
        after.key.length > 1032 ||
        after.key.includes("\0") ||
        Object.keys(after).some((field) => !["kind", "updatedAt", "key"].includes(field))
      )
        throw new Error("Invalid model trace session cursor");
    }
    const candidates = after
      ? items.filter(
          (item) =>
            item.updatedAt < after!.updatedAt ||
            (item.updatedAt === after!.updatedAt && item.key.localeCompare(after!.key) < 0),
        )
      : items;
    const limit = query.limit ?? 50;
    const pageItems = candidates.slice(0, limit);
    const last = pageItems.at(-1);
    return {
      items: pageItems,
      total: items.length,
      ...(candidates.length > limit && last
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({ kind: "sessions", updatedAt: last.updatedAt, key: last.key }),
            ).toString("base64url"),
          }
        : {}),
    };
  }
  get(id: string): ModelTraceRecord | null {
    if (!validId(id)) throw new Error("Invalid model trace ID");
    if (!this.directorySafe(join(this.storageDir, "records"))) return null;
    const record = readJson(join(this.storageDir, "records", `${key(id)}.json`), MAX_RECORD_BYTES);
    if (
      !record ||
      record.version !== 1 ||
      record.id !== id ||
      !Array.isArray(record.attempts) ||
      !statuses.has(record.status) ||
      record.startedAt < Date.now() - this.getConfig().retentionDays * 86_400_000
    )
      return null;
    return { ...record, callType: deriveModelTraceCallType(record) };
  }
  events(traceId: string): ModelTraceEvent[] {
    if (!validId(traceId)) throw new Error("Invalid model trace ID");
    const directory = join("events", key(traceId));
    const cutoff = Date.now() - this.getConfig().retentionDays * 86_400_000;
    return this.files(directory)
      .flatMap((name) => {
        const event = readJson(join(this.storageDir, directory, name), MAX_RECORD_BYTES);
        return event &&
          event.traceId === traceId &&
          validId(event.id) &&
          Number.isFinite(event.startedAt) &&
          event.startedAt >= cutoff &&
          ["tool", "approval", "lifecycle"].includes(event.kind)
          ? [event as ModelTraceEvent]
          : [];
      })
      .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  }
  /** Exact recorder lookup; continuations may retain an earlier safe span snapshot. */
  getEvent(traceId: string, id: string): ModelTraceEvent | null {
    if (!validId(traceId) || !validId(id)) throw new Error("Invalid model trace event ID");
    const directory = join(this.storageDir, "events", key(traceId));
    if (!this.directorySafe(directory)) return null;
    const event = readJson(join(directory, `${key(id)}.json`), MAX_RECORD_BYTES);
    return event &&
      event.traceId === traceId &&
      event.id === id &&
      Number.isFinite(event.startedAt) &&
      event.startedAt >= Date.now() - this.getConfig().retentionDays * 86_400_000 &&
      ["tool", "approval", "lifecycle"].includes(event.kind)
      ? (event as ModelTraceEvent)
      : null;
  }
  /** Recorder-only write; observational persistence never participates in request admission. */
  write(record: ModelTraceRecord): void {
    if (!validId(record.id) || !validId(record.traceId)) throw new Error("Invalid model trace ID");
    const safeRecord = structuredClone(record);
    // Categories are projected from attribution on every read; never persist a
    // caller-supplied label as an independent authority or migration requirement.
    delete safeRecord.callType;
    let raw = JSON.stringify(safeRecord);
    if (Buffer.byteLength(raw) > MAX_RECORD_BYTES) {
      for (const attempt of safeRecord.attempts) {
        delete attempt.input;
        delete attempt.output;
        if (attempt.inputState !== "not-recorded") attempt.inputState = "truncated";
        if (attempt.outputState !== "not-recorded") attempt.outputState = "truncated";
        raw = JSON.stringify(safeRecord);
        if (Buffer.byteLength(raw) <= MAX_RECORD_BYTES) break;
      }
    }
    if (Buffer.byteLength(raw) > MAX_RECORD_BYTES)
      throw new Error("Model trace exceeds storage bound");
    this.writeJson(join(this.storageDir, "records"), `${key(record.id)}.json`, safeRecord);
    this.writeJson(
      join(this.storageDir, "summaries"),
      `${key(record.id)}.json`,
      summary(safeRecord),
    );
    this.prune();
  }
  writeEvent(event: ModelTraceEvent): void {
    if (!validId(event.id) || !validId(event.traceId))
      throw new Error("Invalid model trace event ID");
    this.writeJson(
      join(this.storageDir, "events", key(event.traceId)),
      `${key(event.id)}.json`,
      event,
    );
    this.prune();
  }
  private files(relative: string): string[] {
    try {
      const directory = join(this.storageDir, relative);
      if (!this.directorySafe(directory)) return [];
      return readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    } catch {
      return [];
    }
  }
  private writeJson(directory: string, name: string, value: unknown): void {
    if (!this.directorySafe(directory, true))
      throw new Error("Model trace storage must contain only owned directories");
    if (process.platform !== "win32") chmodSync(directory, 0o700);
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      renameSync(temporary, join(directory, name));
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  private directorySafe(directory: string, create = false): boolean {
    const suffix = relative(this.storageDir, directory);
    if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) return false;
    let current = this.storageDir;
    try {
      const segments = ["", ...suffix.split(sep).filter(Boolean)];
      for (const segment of segments) {
        if (segment) current = join(current, segment);
        if (!existsSync(current)) {
          if (!create) return false;
          mkdirSync(current, { recursive: segment === "", mode: 0o700 });
        }
        const info = lstatSync(current);
        if (info.isSymbolicLink() || !info.isDirectory()) return false;
      }
      return true;
    } catch {
      return false;
    }
  }
  /** Await optional retention work, e.g. before a Host disposes its storage. */
  async flushMaintenance(): Promise<void> {
    this.maintenanceWaiters++;
    try {
      while (this.maintenance) {
        this.maintenanceWake?.ref?.();
        await this.maintenance;
      }
    } finally {
      this.maintenanceWaiters--;
    }
  }

  private prune(force = false): void {
    if (this.maintenance) {
      if (force) this.maintenanceAgain = true;
      return;
    }
    if (!force && Date.now() - this.lastPruned < 60_000) return;
    this.lastPruned = Date.now();
    // Scheduling synchronous scans in setImmediate still saturates Electron's
    // main thread. Scan/read asynchronously with only one file in flight,
    // independently of request admission. Only an expired file's final checked
    // deletion is synchronous, so a same-process writer cannot interleave there.
    const candidates = this.retentionCandidates();
    this.maintenance = new Promise<void>((resolveDone) => {
      const queueStep = () => {
        this.maintenanceWake = setImmediate(() => {
          this.maintenanceWake = undefined;
          void step();
        });
        if (!this.maintenanceWaiters) this.maintenanceWake.unref?.();
      };
      const finish = () => {
        this.maintenance = undefined;
        resolveDone();
        if (this.maintenanceAgain) {
          this.maintenanceAgain = false;
          this.prune(true);
        }
      };
      const step = async () => {
        try {
          const policy = await this.readRetentionJson(join(this.storageDir, "config.json"), 4096);
          const cutoff = Date.now() - retentionDays(policy?.value) * 86_400_000;
          for (let count = 0; count < 8; count++) {
            const next = await candidates.next();
            if (next.done) return finish();
            const { file, startedAt, info, directory } = next.value;
            try {
              if (directory && (await this.directorySafeAsync(directory))) {
                // Never recurse: a concurrent writer makes rmdir fail harmlessly.
                await fs.rmdir(directory);
              } else if (file && info) {
                const time = Number.isFinite(startedAt) ? startedAt! : info.mtimeMs;
                if (time < cutoff) this.removeExpired(file, info, time);
              }
            } catch {
              /* A writer or another process may replace/prune a record. */
            }
          }
          queueStep();
        } catch {
          // Trace retention must neither fail a request nor leave a rejected
          // background promise. A future write retries after the interval.
          finish();
        }
      };
      queueStep();
    });
  }

  private async directorySafeAsync(directory: string): Promise<boolean> {
    const suffix = relative(this.storageDir, directory);
    if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) return false;
    let current = this.storageDir;
    try {
      for (const segment of ["", ...suffix.split(sep).filter(Boolean)]) {
        if (segment) current = join(current, segment);
        const info = await fs.lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private async retentionEntries(directory: string): Promise<string[]> {
    try {
      return (await this.directorySafeAsync(directory)) ? await fs.readdir(directory) : [];
    } catch {
      return [];
    }
  }

  private async readRetentionJson(
    file: string,
    maxBytes: number,
  ): Promise<{ value: any; info: Stats } | null> {
    if (!(await this.directorySafeAsync(dirname(file)))) return null;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      const before = await fs.lstat(file);
      if (!before.isFile() || before.isSymbolicLink()) return null;
      if (before.size > maxBytes) return { value: null, info: before };
      // Do not follow a replaced leaf symlink or block on a special file. Read
      // through the validated handle with a fixed bound, even if a writer grows it.
      handle = await fs.open(
        file,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.size > maxBytes ||
        info.dev !== before.dev ||
        info.ino !== before.ino
      )
        return null;
      if (!(await this.directorySafeAsync(dirname(file)))) return null;
      const bytes = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > info.size) return null;
      let value: any = null;
      try {
        value = JSON.parse(bytes.subarray(0, length).toString("utf8"));
      } catch {
        /* Corrupt summaries/bodies retain the existing mtime fallback. */
      }
      return { value, info };
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  private removeExpired(file: string, original: Stats, startedAt: number): void {
    // Commit one deletion in the same JS turn as its final validation. An async
    // unlink can run after a writer replaces the checked file or extends policy.
    // These bounded checks run only for expired candidates; the historical scan
    // and content reads remain asynchronous, yielding before the next candidate.
    if (startedAt >= Date.now() - this.getConfig().retentionDays * 86_400_000) return;
    if (!this.directorySafe(dirname(file))) return;
    const current = lstatSync(file);
    if (
      current.isFile() &&
      !current.isSymbolicLink() &&
      current.dev === original.dev &&
      current.ino === original.ino &&
      current.mtimeMs === original.mtimeMs &&
      current.size === original.size
    )
      unlinkSync(file);
  }

  private async *retentionCandidates(): AsyncGenerator<{
    file?: string;
    startedAt?: number;
    info?: Stats;
    directory?: string;
  }> {
    const startedByName = new Map<string, { startedAt: number; mtimeMs: number }>();
    for (const name of await this.retentionEntries(join(this.storageDir, "summaries"))) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const file = join(this.storageDir, "summaries", name);
      const row = await this.readRetentionJson(file, MAX_SUMMARY_BYTES);
      if (!row) continue;
      if (Number.isFinite(row.value?.startedAt))
        startedByName.set(name, { startedAt: row.value.startedAt, mtimeMs: row.info.mtimeMs });
      yield { file, startedAt: row.value?.startedAt, info: row.info };
    }
    // A crash between atomic writes can leave a body without its summary. Inspect
    // orphan or newly replaced bodies independently; normal retention only reads
    // small summaries and stats the corresponding immutable body.
    for (const name of await this.retentionEntries(join(this.storageDir, "records"))) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const file = join(this.storageDir, "records", name);
      try {
        if (!(await this.directorySafeAsync(dirname(file)))) continue;
        let info = await fs.lstat(file);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        const cached = startedByName.get(name);
        let startedAt = cached?.startedAt;
        if (!cached || info.mtimeMs >= cached.mtimeMs) {
          const row = await this.readRetentionJson(file, MAX_RECORD_BYTES);
          if (!row) continue;
          startedAt = row.value?.startedAt;
          info = row.info;
        }
        yield { file, startedAt, info };
      } catch {
        /* The record may have been replaced or pruned. */
      }
    }
    for (const name of await this.retentionEntries(join(this.storageDir, "events"))) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      const directory = join(this.storageDir, "events", name);
      for (const name of await this.retentionEntries(directory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const file = join(directory, name);
        const event = await this.readRetentionJson(file, MAX_RECORD_BYTES);
        // Preserve unreadable/corrupt event bytes as before. Each attempted read
        // awaits actual I/O, so corruption cannot turn this into a synchronous scan.
        if (event?.value) yield { file, startedAt: event.value.startedAt, info: event.info };
      }
      yield { directory };
    }
  }
}

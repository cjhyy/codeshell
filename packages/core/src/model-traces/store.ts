import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ModelTraceConfig,
  ModelTraceConfigPatch,
  ModelTraceEvent,
  ModelTraceListQuery,
  ModelTracePage,
  ModelTraceRecord,
  ModelTraceSummary,
} from "./types.js";

export const DEFAULT_MODEL_TRACE_CONFIG: Readonly<ModelTraceConfig> = Object.freeze({
  policyRevision: "initial",
  enabled: true,
  captureContent: false,
  retentionDays: 7,
  includeEphemeral: false,
});
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_SUMMARY_BYTES = 32 * 1024;
const key = (id: string) => createHash("sha256").update(id).digest("hex");
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
  constructor({ storageDir }: { storageDir: string }) {
    if (typeof storageDir !== "string" || !storageDir || storageDir.includes("\0"))
      throw new Error("Model trace storage directory required");
    this.storageDir = resolve(storageDir);
  }
  getConfig(): ModelTraceConfig {
    const saved = this.directorySafe(this.storageDir)
      ? readJson(join(this.storageDir, "config.json"), 4096)
      : null;
    return {
      policyRevision:
        typeof saved?.policyRevision === "string" &&
        /^[A-Za-z0-9_-]{1,128}$/.test(saved.policyRevision)
          ? saved.policyRevision
          : "initial",
      enabled: typeof saved?.enabled === "boolean" ? saved.enabled : true,
      captureContent: typeof saved?.captureContent === "boolean" ? saved.captureContent : false,
      includeEphemeral:
        typeof saved?.includeEphemeral === "boolean" ? saved.includeEphemeral : false,
      retentionDays:
        Number.isSafeInteger(saved?.retentionDays) &&
        saved.retentionDays >= 1 &&
        saved.retentionDays <= 365
          ? saved.retentionDays
          : 7,
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
    this.writeJson(this.storageDir, "config.json", config);
    this.prune(true);
    return config;
  }
  list(query: ModelTraceListQuery = {}): ModelTracePage {
    if (!query || typeof query !== "object" || Array.isArray(query))
      throw new Error("Invalid model trace query");
    const limit = query.limit ?? 50;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500 ||
      (query.status !== undefined && !statuses.has(query.status)) ||
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
      rows.push(
        Object.fromEntries(
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
        ) as unknown as ModelTraceSummary,
      );
    }
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
    return record;
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
  private prune(force = false): void {
    if (!force && Date.now() - this.lastPruned < 60_000) return;
    this.lastPruned = Date.now();
    const cutoff = Date.now() - this.getConfig().retentionDays * 86_400_000;
    const startedByName = new Map<string, number>();
    const removeExpired = (file: string, startedAt: unknown) => {
      try {
        const time =
          typeof startedAt === "number" && Number.isFinite(startedAt)
            ? startedAt
            : lstatSync(file).mtimeMs;
        if (time < cutoff) rmSync(file);
      } catch {
        /* Another process may prune concurrently. */
      }
    };
    for (const name of this.files("summaries")) {
      const file = join(this.storageDir, "summaries", name);
      const row = readJson(file, MAX_SUMMARY_BYTES);
      if (Number.isFinite(row?.startedAt)) startedByName.set(name, row.startedAt);
      removeExpired(file, row?.startedAt);
    }
    // A crash between atomic writes can leave a body without its summary. Inspect
    // orphan bodies independently, while normal retention only reads small summaries.
    for (const name of this.files("records")) {
      const file = join(this.storageDir, "records", name);
      let startedAt = startedByName.get(name);
      if (startedAt === undefined) {
        const row = readJson(file, MAX_RECORD_BYTES);
        startedAt = row?.startedAt;
      }
      removeExpired(file, startedAt);
    }
    try {
      if (!this.directorySafe(join(this.storageDir, "events"))) return;
      for (const directory of readdirSync(join(this.storageDir, "events"))) {
        if (!/^[a-f0-9]{64}$/.test(directory)) continue;
        for (const name of this.files(join("events", directory))) {
          const event = readJson(
            join(this.storageDir, "events", directory, name),
            MAX_RECORD_BYTES,
          );
          if (event && event.startedAt < cutoff)
            try {
              rmSync(join(this.storageDir, "events", directory, name));
            } catch {
              /* Concurrent cleanup. */
            }
        }
      }
    } catch {
      /* The store may not contain events yet. */
    }
  }
}

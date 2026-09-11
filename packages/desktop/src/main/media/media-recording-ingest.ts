import { createHash, randomUUID, type Hash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { MediaLibrary, mediaSourceIdentity } from "./media-library.js";
import { inspectMediaFile, type MediaInspection } from "./media-processors.js";
import {
  mediaDirectory,
  mediaScopeKey,
  normalizeMediaScope,
  readMediaJson,
  writeMediaJson,
} from "./media-storage.js";
import type { MediaAsset, MediaJobContext, MediaScope } from "./media-types.js";

const MIME_EXTENSIONS: Record<string, string> = {
  "video/webm": ".webm",
  "video/mp4": ".mp4",
  "audio/webm": ".webm",
  "audio/mp4": ".m4a",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
};
const SESSION_ID = /^recording-[a-f0-9-]{36}$/;
const MAX_FILE_BYTES = 20 * 1024 ** 3;
const CHUNK_BYTES = 32 * 1024;
type State = "uploading" | "finishing" | "finished" | "cancelled" | "failed";
export interface RecordingSession {
  sessionId: string;
  mimeType: string;
  state: State;
  receivedBytes: number;
  nextSequence: number;
  maxChunkBytes: number;
  maxFileBytes: number;
  expiresAt: number;
}
export interface RecordingResult {
  asset: MediaAsset;
  inspection: MediaInspection;
  provenance: { kind: "recording" };
}
interface StoredSession {
  schemaVersion: 1;
  scope: MediaScope;
  sessionId: string;
  mimeType: string;
  name: string;
  state: State;
  receivedBytes: number;
  nextSequence: number;
  expectedBytes?: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  lastChunk?: { sequence: number; offset: number; bytes: number; sha256: string };
  result?: RecordingResult;
}
export interface RecordingIngestOptions {
  rootDirectory: string;
  library: MediaLibrary;
  isScopeAuthorized(scope: MediaScope): boolean;
  ffprobePath?: string;
  maxFileBytes?: number;
  maxChunkBytes?: number;
  maxActivePerScope?: number;
  maxActiveSessions?: number;
  ttlMs?: number;
  finishTimeoutMs?: number;
  now?: () => number;
}

function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new Error("Invalid recording parameters");
  return value as Record<string, unknown>;
}
function sessionId(value: unknown): string {
  if (typeof value !== "string" || !SESSION_ID.test(value))
    throw new Error("Invalid recording session ID");
  return value;
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    throw new Error(`Invalid recording ${label}`);
  return value as number;
}
function mimeType(value: unknown): string {
  if (typeof value !== "string" || value.length > 200)
    throw new Error("Unsupported recording MIME type");
  // MediaRecorder may include codecs. The Host still validates the actual bytes.
  const mime = value.split(";", 1)[0]!.trim().toLowerCase();
  if (!Object.hasOwn(MIME_EXTENSIONS, mime)) throw new Error("Unsupported recording MIME type");
  return mime;
}
function nameFor(value: unknown, mime: string): string {
  if (value !== undefined && (typeof value !== "string" || value.length > 240))
    throw new Error("Invalid recording name");
  const name = basename(typeof value === "string" ? value : "recording")
    .replace(/[\\/\x00-\x1f\x7f]/g, "_")
    .trim();
  return `${name.slice(0, name.length - extname(name).length).slice(0, 200) || "recording"}${MIME_EXTENSIONS[mime]}`;
}
function active(record: StoredSession): boolean {
  return record.state === "uploading" || record.state === "finishing";
}
function invalidMedia(): Error {
  return Object.assign(
    new Error("Recording bytes do not match a supported audio/video recording"),
    { name: "InvalidRecordingError" },
  );
}

/** Scope-bound, streaming recordings. Acknowledged chunks and final results survive Host restart. */
export class MediaRecordingIngest {
  private readonly options: Required<Omit<RecordingIngestOptions, "ffprobePath">> &
    Pick<RecordingIngestOptions, "ffprobePath">;
  private readonly records = new Map<string, StoredSession>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly hashes = new Map<string, { bytes: number; hash: Hash }>();
  private readonly finishes = new Map<string, AbortController>();
  private readonly cancellations = new Set<string>();
  private initialization?: Promise<void>;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private stopping = false;
  constructor(options: RecordingIngestOptions) {
    this.options = {
      maxFileBytes: MAX_FILE_BYTES,
      maxChunkBytes: CHUNK_BYTES,
      maxActivePerScope: 4,
      maxActiveSessions: 64,
      ttlMs: 24 * 60 * 60 * 1000,
      finishTimeoutMs: 10 * 60 * 1000,
      now: Date.now,
      ...options,
    };
    integer(this.options.maxFileBytes, 1, MAX_FILE_BYTES, "file budget");
    integer(this.options.maxChunkBytes, 1, CHUNK_BYTES, "chunk budget");
    integer(this.options.maxActivePerScope, 1, 16, "scope session budget");
    integer(this.options.maxActiveSessions, 1, 256, "session budget");
    integer(this.options.ttlMs, 1, 7 * 86400 * 1000, "expiry");
    integer(this.options.finishTimeoutMs, 1, 30 * 60 * 1000, "finish timeout");
  }
  private key(scope: MediaScope, id: string): string {
    return `${mediaScopeKey(scope)}:${id}`;
  }
  private authorize(scope: MediaScope): void {
    normalizeMediaScope(scope);
    if (!this.options.isScopeAuthorized(scope))
      throw new Error("Recording access is no longer authorized");
    if (this.stopping) throw new Error("Recording service is shutting down");
  }
  private async directory(scope: MediaScope, id: string, create = false): Promise<string> {
    return mediaDirectory(
      this.options.rootDirectory,
      ["scopes", mediaScopeKey(scope), "recordings", sessionId(id)],
      create,
    );
  }
  private async locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    const operation = (this.locks.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    this.locks.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.locks.get(key) === operation) this.locks.delete(key);
    }
  }
  private view(record: StoredSession): RecordingSession {
    return {
      sessionId: record.sessionId,
      mimeType: record.mimeType,
      state: record.state,
      receivedBytes: record.receivedBytes,
      nextSequence: record.nextSequence,
      maxChunkBytes: this.options.maxChunkBytes,
      maxFileBytes: this.options.maxFileBytes,
      expiresAt: record.expiresAt,
    };
  }
  private async save(record: StoredSession): Promise<void> {
    await writeMediaJson(
      join(await this.directory(record.scope, record.sessionId), "session.json"),
      record,
    );
    this.records.set(this.key(record.scope, record.sessionId), record);
  }
  private validateRecord(raw: unknown, key: string, id: string): StoredSession {
    const record = raw as StoredSession;
    if (
      !record ||
      record.schemaVersion !== 1 ||
      record.sessionId !== id ||
      mediaScopeKey(record.scope) !== key ||
      !["uploading", "finishing", "finished", "cancelled", "failed"].includes(record.state) ||
      record.mimeType !== mimeType(record.mimeType) ||
      record.name !== nameFor(record.name, record.mimeType)
    )
      throw new Error("Invalid stored recording session");
    integer(record.receivedBytes, 0, this.options.maxFileBytes, "stored size");
    integer(record.nextSequence, 0, Number.MAX_SAFE_INTEGER, "stored sequence");
    integer(record.createdAt, 0, Number.MAX_SAFE_INTEGER, "created time");
    integer(record.updatedAt, record.createdAt, Number.MAX_SAFE_INTEGER, "updated time");
    integer(record.expiresAt, record.updatedAt, Number.MAX_SAFE_INTEGER, "stored expiry");
    if (record.expectedBytes !== undefined)
      integer(
        record.expectedBytes,
        Math.max(1, record.receivedBytes),
        this.options.maxFileBytes,
        "expected size",
      );
    if (record.lastChunk) {
      integer(record.lastChunk.offset, 0, record.receivedBytes, "stored chunk offset");
      integer(record.lastChunk.bytes, 1, CHUNK_BYTES, "stored chunk size");
      if (
        record.lastChunk.sequence !== record.nextSequence - 1 ||
        record.lastChunk.offset + record.lastChunk.bytes !== record.receivedBytes ||
        !/^[a-f0-9]{64}$/.test(record.lastChunk.sha256)
      )
        throw new Error("Invalid stored recording chunk");
    } else if (record.nextSequence !== 0 || record.receivedBytes !== 0)
      throw new Error("Stored recording lacks its last acknowledged chunk");
    if (
      record.state === "finished" &&
      (!record.result || !/^asset-[a-f0-9]{64}$/.test(record.result.asset?.id))
    )
      throw new Error("Invalid finished recording");
    return record;
  }
  initialize(): Promise<void> {
    this.initialization ??= (async () => {
      const scopes = await mediaDirectory(this.options.rootDirectory, ["scopes"]);
      for (const scopeEntry of await readdir(scopes, { withFileTypes: true })) {
        if (!scopeEntry.isDirectory() || !/^[a-f0-9]{64}$/.test(scopeEntry.name)) continue;
        const directory = await mediaDirectory(
          this.options.rootDirectory,
          ["scopes", scopeEntry.name, "recordings"],
          false,
        ).catch(() => null);
        if (!directory) continue;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
          const child = await mediaDirectory(
            this.options.rootDirectory,
            ["scopes", scopeEntry.name, "recordings", entry.name],
            false,
          );
          try {
            const record = this.validateRecord(
              await readMediaJson(join(child, "session.json")),
              scopeEntry.name,
              entry.name,
            );
            if (record.expiresAt <= this.options.now()) {
              await rm(child, { recursive: true, force: true });
              continue;
            }
            // Finalization only reads immutable uploaded bytes and publishes by
            // content hash, so an explicit finish retry is safe after a crash.
            if (record.state === "finishing") {
              record.state = "uploading";
              await this.save(record);
            }
            this.records.set(this.key(record.scope, record.sessionId), record);
          } catch {
            await rm(child, { recursive: true, force: true });
          }
        }
      }
      if (!this.stopping) {
        this.cleanupTimer = setInterval(
          () => {
            void this.cleanupExpired().catch(() => {});
          },
          Math.max(1000, Math.min(60000, this.options.ttlMs)),
        );
        this.cleanupTimer.unref();
      }
    })();
    return this.initialization;
  }
  private async record(scope: MediaScope, id: string): Promise<StoredSession> {
    this.authorize(scope);
    const record = this.records.get(this.key(scope, id));
    if (!record) throw new Error("Unknown recording session in this project");
    if (record.expiresAt <= this.options.now()) {
      await this.remove(record);
      throw new Error("Recording session expired; start another recording");
    }
    await this.directory(scope, id);
    return record;
  }
  private async remove(record: StoredSession): Promise<void> {
    const key = this.key(record.scope, record.sessionId);
    this.finishes.get(key)?.abort();
    const directory = await this.directory(record.scope, record.sessionId).catch(() => null);
    if (directory) await rm(directory, { recursive: true, force: true });
    this.records.delete(key);
    this.hashes.delete(key);
  }
  async cleanupExpired(): Promise<void> {
    await this.initialize();
    for (const record of [...this.records.values()])
      if (record.expiresAt <= this.options.now()) {
        const key = this.key(record.scope, record.sessionId);
        this.finishes.get(key)?.abort();
        await this.locked(key, () => this.remove(record));
      }
  }
  async begin(scope: MediaScope, raw: unknown): Promise<RecordingSession> {
    this.authorize(scope);
    await this.initialize();
    const input = object(raw, ["mimeType", "name", "expectedBytes"]);
    const mime = mimeType(input.mimeType),
      name = nameFor(input.name, mime);
    const expectedBytes =
      input.expectedBytes === undefined
        ? undefined
        : integer(input.expectedBytes, 1, this.options.maxFileBytes, "expected size");
    await this.cleanupExpired();
    return this.locked("begin", async () => {
      this.authorize(scope);
      // Completed/failed receipts are small but also bounded until their TTL.
      if (this.records.size >= 2048)
        throw new Error("Too many retained recording sessions; wait for expired sessions to clear");
      const all = [...this.records.values()].filter(active);
      if (
        all.length >= this.options.maxActiveSessions ||
        all.filter((record) => mediaScopeKey(record.scope) === mediaScopeKey(scope)).length >=
          this.options.maxActivePerScope
      )
        throw new Error("Too many active recording uploads; finish or cancel one first");
      const id = `recording-${randomUUID()}`,
        time = this.options.now();
      const directory = await this.directory(scope, id, true);
      const handle = await open(join(directory, "content.partial"), "wx", 0o600);
      await handle.close();
      const record: StoredSession = {
        schemaVersion: 1,
        scope: normalizeMediaScope(scope),
        sessionId: id,
        mimeType: mime,
        name,
        state: "uploading",
        receivedBytes: 0,
        nextSequence: 0,
        createdAt: time,
        updatedAt: time,
        expiresAt: time + this.options.ttlMs,
        ...(expectedBytes === undefined ? {} : { expectedBytes }),
      };
      try {
        await this.save(record);
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      return this.view(record);
    });
  }
  async get(scope: MediaScope, raw: unknown): Promise<RecordingSession> {
    await this.initialize();
    const id = sessionId(object(raw, ["sessionId"]).sessionId);
    return this.locked(this.key(scope, id), async () => this.view(await this.record(scope, id)));
  }
  async write(scope: MediaScope, raw: unknown): Promise<RecordingSession> {
    this.authorize(scope);
    await this.initialize();
    const input = object(raw, ["sessionId", "sequence", "offset", "dataBase64"]),
      id = sessionId(input.sessionId);
    const sequence = integer(input.sequence, 0, Number.MAX_SAFE_INTEGER, "sequence"),
      offset = integer(input.offset, 0, this.options.maxFileBytes, "offset");
    if (
      typeof input.dataBase64 !== "string" ||
      input.dataBase64.length > Math.ceil(this.options.maxChunkBytes / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.dataBase64)
    )
      throw new Error("Recording chunks must use bounded canonical base64");
    const bytes = Buffer.from(input.dataBase64, "base64");
    if (
      !bytes.length ||
      bytes.length > this.options.maxChunkBytes ||
      bytes.toString("base64") !== input.dataBase64
    )
      throw new Error("Invalid recording chunk size or encoding");
    const digest = createHash("sha256").update(bytes).digest("hex"),
      key = this.key(scope, id);
    return this.locked(key, async () => {
      const record = await this.record(scope, id);
      if (record.state !== "uploading") throw new Error("Recording no longer accepts chunks");
      if (
        record.lastChunk?.sequence === sequence &&
        record.lastChunk.offset === offset &&
        record.lastChunk.bytes === bytes.length &&
        record.lastChunk.sha256 === digest
      )
        return this.view(record);
      if (sequence !== record.nextSequence || offset !== record.receivedBytes)
        throw new Error("Recording chunks must arrive in sequence at the acknowledged offset");
      if (offset + bytes.length > (record.expectedBytes ?? this.options.maxFileBytes))
        throw new Error("Recording exceeds its file budget");
      const handle = await open(
        join(await this.directory(scope, id), "content.partial"),
        constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size < record.receivedBytes)
          throw new Error("Stored recording bytes are incomplete");
        // A crash between data fsync and metadata commit can leave an unacknowledged
        // tail. Discard only that tail before accepting the client's retry.
        if (info.size > record.receivedBytes) await handle.truncate(record.receivedBytes);
        let hash = this.hashes.get(key);
        if (!hash || hash.bytes !== offset) {
          hash = { bytes: 0, hash: createHash("sha256") };
          const buffer = Buffer.allocUnsafe(256 * 1024);
          while (hash.bytes < offset) {
            const { bytesRead } = await handle.read(
              buffer,
              0,
              Math.min(buffer.length, offset - hash.bytes),
              hash.bytes,
            );
            if (!bytesRead) throw new Error("Stored recording stopped making progress");
            hash.hash.update(buffer.subarray(0, bytesRead));
            hash.bytes += bytesRead;
          }
        }
        let written = 0;
        while (written < bytes.length) {
          this.authorize(scope);
          const result = await handle.write(
            bytes,
            written,
            bytes.length - written,
            offset + written,
          );
          if (!result.bytesWritten) throw new Error("Recording write stopped making progress");
          written += result.bytesWritten;
        }
        await handle.sync();
        this.authorize(scope);
        const time = this.options.now();
        const next: StoredSession = {
          ...record,
          receivedBytes: offset + bytes.length,
          nextSequence: sequence + 1,
          updatedAt: time,
          expiresAt: time + this.options.ttlMs,
          lastChunk: { sequence, offset, bytes: bytes.length, sha256: digest },
        };
        await this.save(next);
        hash.hash.update(bytes);
        hash.bytes += bytes.length;
        this.hashes.set(key, hash);
        return this.view(next);
      } catch (error) {
        this.hashes.delete(key);
        await handle.truncate(record.receivedBytes).catch(() => {});
        throw error;
      } finally {
        await handle.close();
      }
    });
  }
  private async inspect(
    path: string,
    record: StoredSession,
    context: MediaJobContext,
  ): Promise<MediaInspection> {
    try {
      const info = await inspectMediaFile(path, context, { ffprobePath: this.options.ffprobePath });
      const audio = record.mimeType.startsWith("audio/");
      if (
        !info.durationSeconds ||
        info.durationSeconds > 24 * 60 * 60 ||
        (audio ? info.kind !== "audio" : info.kind !== "video")
      )
        throw invalidMedia();
      const container = record.mimeType.split("/")[1];
      if (
        (container === "webm" && !/(^|,)webm(,|$)/.test(info.format)) ||
        (container === "mp4" && !/(^|,)mov(,|$)/.test(info.format)) ||
        (container === "ogg" && info.format !== "ogg") ||
        (container === "wav" && info.format !== "wav")
      )
        throw invalidMedia();
      return info;
    } catch (error) {
      context.signal.throwIfAborted();
      if ((error as Error).name === "InvalidRecordingError") throw error;
      throw invalidMedia();
    }
  }
  async finish(scope: MediaScope, raw: unknown): Promise<RecordingResult> {
    this.authorize(scope);
    await this.initialize();
    const id = sessionId(object(raw, ["sessionId"]).sessionId),
      key = this.key(scope, id);
    return this.locked(key, async () => {
      const record = await this.record(scope, id);
      if (record.state === "finished") {
        await this.options.library.get(scope, record.result!.asset.id);
        return structuredClone(record.result!);
      }
      if (
        record.state !== "uploading" ||
        !record.receivedBytes ||
        (record.expectedBytes !== undefined && record.expectedBytes !== record.receivedBytes)
      )
        throw new Error("Recording is incomplete or no longer accepts finalization");
      const controller = new AbortController();
      this.finishes.set(key, controller);
      // cancel may be queued behind a write before finish acquires the lock.
      // Remember that intent even when there is not yet a running process.
      if (this.cancellations.has(key)) controller.abort();
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(this.options.finishTimeoutMs),
      ]);
      const directory = await this.directory(scope, id),
        path = join(directory, "content.partial");
      const context: MediaJobContext = {
        scope,
        jobId: id,
        attempt: 1,
        signal,
        workDir: directory,
        outputDir: directory,
        cacheDir: directory,
        reportProgress: async () => {
          signal.throwIfAborted();
        },
      };
      await this.save({ ...record, state: "finishing" });
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
        const info = await handle.stat();
        if (!info.isFile() || info.size < record.receivedBytes) throw invalidMedia();
        if (info.size > record.receivedBytes) await handle.truncate(record.receivedBytes);
        await handle.sync();
        const identity = mediaSourceIdentity(await handle.stat());
        const digest = createHash("sha256"),
          buffer = Buffer.allocUnsafe(256 * 1024);
        let read = 0;
        while (read < record.receivedBytes) {
          signal.throwIfAborted();
          this.authorize(scope);
          const { bytesRead } = await handle.read(
            buffer,
            0,
            Math.min(buffer.length, record.receivedBytes - read),
            read,
          );
          if (!bytesRead) throw invalidMedia();
          digest.update(buffer.subarray(0, bytesRead));
          read += bytesRead;
        }
        const sha256 = digest.digest("hex");
        const inspection = await this.inspect(path, record, context);
        signal.throwIfAborted();
        this.authorize(scope);
        const asset = await this.options.library.importFile(scope, path, {
          name: record.name,
          mimeType: record.mimeType,
          signal,
          expectedSource: identity,
        });
        if (asset.sha256 !== sha256 || asset.bytes !== record.receivedBytes) throw invalidMedia();
        signal.throwIfAborted();
        this.authorize(scope);
        const result: RecordingResult = { asset, inspection, provenance: { kind: "recording" } };
        const time = this.options.now();
        await this.save({
          ...record,
          state: "finished",
          result,
          updatedAt: time,
          expiresAt: time + this.options.ttlMs,
        });
        this.hashes.delete(key);
        await handle.close();
        handle = undefined;
        await rm(path, { force: true });
        return structuredClone(result);
      } catch (error) {
        await handle?.close();
        handle = undefined;
        const invalid = (error as Error).name === "InvalidRecordingError";
        if (invalid) {
          await rm(path, { force: true });
          this.hashes.delete(key);
        }
        await this.save({ ...record, state: invalid ? "failed" : "uploading" });
        throw error;
      } finally {
        await handle?.close().catch(() => {});
        this.finishes.delete(key);
      }
    });
  }
  async cancel(scope: MediaScope, raw: unknown): Promise<{ cancelled: true }> {
    this.authorize(scope);
    await this.initialize();
    const id = sessionId(object(raw, ["sessionId"]).sessionId),
      key = this.key(scope, id);
    this.cancellations.add(key);
    this.finishes.get(key)?.abort();
    try {
      return await this.locked(key, async () => {
        const record = await this.record(scope, id);
        if (record.state === "finished") throw new Error("Recording is already a managed asset");
        await rm(join(await this.directory(scope, id), "content.partial"), { force: true });
        this.hashes.delete(key);
        await this.save({ ...record, state: "cancelled" });
        return { cancelled: true };
      });
    } finally {
      this.cancellations.delete(key);
    }
  }
  async cancelScope(scope: MediaScope): Promise<void> {
    await this.initialize();
    await this.cancelWhere((record) => mediaScopeKey(record.scope) === mediaScopeKey(scope));
  }
  async cancelApp(appId: string): Promise<void> {
    await this.initialize();
    await this.cancelWhere((record) => record.scope.appId === appId);
  }
  private async cancelWhere(matches: (record: StoredSession) => boolean): Promise<void> {
    const records = [...this.records.values()].filter(
      (record) => active(record) && matches(record),
    );
    for (const record of records) {
      const key = this.key(record.scope, record.sessionId);
      this.cancellations.add(key);
      this.finishes.get(key)?.abort();
    }
    await Promise.all(
      records.map(async (record) => {
        const key = this.key(record.scope, record.sessionId);
        try {
          await this.locked(key, () => this.remove(record));
        } finally {
          this.cancellations.delete(key);
        }
      }),
    );
  }
  async shutdown(): Promise<void> {
    this.stopping = true;
    clearInterval(this.cleanupTimer);
    for (const controller of this.finishes.values()) controller.abort();
    await Promise.allSettled([...this.locks.values()]);
    this.hashes.clear();
  }
}

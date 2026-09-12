import { createHash, randomUUID, type Hash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { MediaLibrary, mediaSourceIdentity } from "./library.js";
import {
  mediaDirectory,
  mediaScopeKey,
  normalizeMediaScope,
  readMediaJson,
  writeMediaJson,
} from "./storage.js";
import type { MediaAsset, MediaScope } from "./types.js";

const SESSION_ID = /^upload-[a-f0-9-]{36}$/;
const MAX_FILE_BYTES = 20 * 1024 ** 3;
const CHUNK_BYTES = 32 * 1024;
type State = "uploading" | "finishing" | "finished" | "cancelled" | "failed";
export interface ResourceUploadSession {
  sessionId: string;
  mimeType: string;
  state: State;
  receivedBytes: number;
  nextSequence: number;
  maxChunkBytes: number;
  maxFileBytes: number;
  expiresAt: number;
}
export interface ResourceUploadResult {
  asset: MediaAsset;
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
  expectedSha256?: string;
  contentSha256: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  lastChunk?: { sequence: number; offset: number; bytes: number; sha256: string };
  result?: ResourceUploadResult;
}
export interface ResourceUploadOptions {
  rootDirectory: string;
  library: MediaLibrary;
  isScopeAuthorized(scope: MediaScope): boolean | Promise<boolean>;
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
    throw new Error("Invalid resource upload parameters");
  return value as Record<string, unknown>;
}
function sessionId(value: unknown): string {
  if (typeof value !== "string" || !SESSION_ID.test(value))
    throw new Error("Invalid resource upload session ID");
  return value;
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    throw new Error(`Invalid resource upload ${label}`);
  return value as number;
}
function mimeType(value: unknown): string {
  if (value === undefined) return "application/octet-stream";
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value)
  )
    throw new Error("Invalid resource MIME type");
  return value.toLowerCase();
}
function nameFor(value: unknown, _mime: string): string {
  if (typeof value !== "string" || !value || value.length > 240 || /[\x00-\x1f\x7f]/.test(value))
    throw new Error("Invalid resource name");
  return basename(value).replaceAll("\\", "_");
}
function active(record: StoredSession): boolean {
  return record.state === "uploading" || record.state === "finishing";
}
function invalidMedia(): Error {
  return Object.assign(new Error("Resource upload bytes failed integrity validation"), {
    name: "InvalidResourceUploadError",
  });
}

/** Scope-bound, streaming resource uploads. Acknowledged chunks and final results survive Host restart. */
export class ResourceUploadIngest {
  private readonly options: Required<ResourceUploadOptions>;
  private readonly records = new Map<string, StoredSession>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly hashes = new Map<string, { bytes: number; hash: Hash }>();
  private readonly finishes = new Map<string, AbortController>();
  private readonly cancellations = new Set<string>();
  private initialization?: Promise<void>;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private stopping = false;
  constructor(options: ResourceUploadOptions) {
    this.options = {
      maxChunkBytes: CHUNK_BYTES,
      maxActivePerScope: 4,
      maxActiveSessions: 64,
      ttlMs: 24 * 60 * 60 * 1000,
      finishTimeoutMs: 10 * 60 * 1000,
      now: Date.now,
      ...options,
      maxFileBytes: options.maxFileBytes ?? MAX_FILE_BYTES,
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
  private async authorize(scope: MediaScope): Promise<void> {
    normalizeMediaScope(scope);
    if (!(await this.options.isScopeAuthorized(scope)))
      throw new Error("Resource upload access is no longer authorized");
    if (this.stopping) throw new Error("Resource upload service is shutting down");
  }
  private async directory(scope: MediaScope, id: string, create = false): Promise<string> {
    return mediaDirectory(
      this.options.rootDirectory,
      ["scopes", mediaScopeKey(scope), "uploads", sessionId(id)],
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
  private view(record: StoredSession): ResourceUploadSession {
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
      record.name !== nameFor(record.name, record.mimeType) ||
      !/^[a-f0-9]{64}$/.test(record.contentSha256) ||
      (record.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(record.expectedSha256))
    )
      throw new Error("Invalid stored resource upload session");
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
        throw new Error("Invalid stored resource upload chunk");
    } else if (record.nextSequence !== 0 || record.receivedBytes !== 0)
      throw new Error("Stored resource upload lacks its last acknowledged chunk");
    if (
      record.state === "finished" &&
      (!record.result || !/^asset-[a-f0-9]{64}$/.test(record.result.asset?.id))
    )
      throw new Error("Invalid finished resource upload");
    return record;
  }
  initialize(): Promise<void> {
    this.initialization ??= (async () => {
      const scopes = await mediaDirectory(this.options.rootDirectory, ["scopes"]);
      for (const scopeEntry of await readdir(scopes, { withFileTypes: true })) {
        if (!scopeEntry.isDirectory() || !/^[a-f0-9]{64}$/.test(scopeEntry.name)) continue;
        const directory = await mediaDirectory(
          this.options.rootDirectory,
          ["scopes", scopeEntry.name, "uploads"],
          false,
        ).catch(() => null);
        if (!directory) continue;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
          const child = await mediaDirectory(
            this.options.rootDirectory,
            ["scopes", scopeEntry.name, "uploads", entry.name],
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
    await this.authorize(scope);
    const record = this.records.get(this.key(scope, id));
    if (!record) throw new Error("Unknown resource upload session in this project");
    if (record.expiresAt <= this.options.now()) {
      await this.remove(record);
      throw new Error("Resource upload session expired; start another resource upload");
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
  async begin(scope: MediaScope, raw: unknown): Promise<ResourceUploadSession> {
    await this.authorize(scope);
    await this.initialize();
    const input = object(raw, ["mimeType", "name", "expectedBytes", "expectedSha256"]);
    const mime = mimeType(input.mimeType),
      name = nameFor(input.name, mime);
    const expectedBytes =
      input.expectedBytes === undefined
        ? undefined
        : integer(input.expectedBytes, 1, this.options.maxFileBytes, "expected size");
    if (
      input.expectedSha256 !== undefined &&
      (typeof input.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedSha256))
    )
      throw new Error("Invalid expected resource digest");
    await this.cleanupExpired();
    return this.locked("begin", async () => {
      await this.authorize(scope);
      // Completed/failed receipts are small but also bounded until their TTL.
      if (this.records.size >= 2048)
        throw new Error(
          "Too many retained resource upload sessions; wait for expired sessions to clear",
        );
      const all = [...this.records.values()].filter(active);
      if (
        all.length >= this.options.maxActiveSessions ||
        all.filter((record) => mediaScopeKey(record.scope) === mediaScopeKey(scope)).length >=
          this.options.maxActivePerScope
      )
        throw new Error("Too many active resource uploads; finish or cancel one first");
      const id = `upload-${randomUUID()}`,
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
        contentSha256: createHash("sha256").digest("hex"),
        ...(input.expectedSha256 === undefined
          ? {}
          : { expectedSha256: input.expectedSha256 as string }),
        createdAt: time,
        updatedAt: time,
        expiresAt: time + this.options.ttlMs,
        ...(expectedBytes === undefined ? {} : { expectedBytes }),
      };
      try {
        await this.authorize(scope);
        await this.save(record);
        await this.authorize(scope);
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        this.records.delete(this.key(scope, id));
        throw error;
      }
      return this.view(record);
    });
  }
  async get(scope: MediaScope, raw: unknown): Promise<ResourceUploadSession> {
    await this.initialize();
    const id = sessionId(object(raw, ["sessionId"]).sessionId);
    return this.locked(this.key(scope, id), async () => this.view(await this.record(scope, id)));
  }
  async write(scope: MediaScope, raw: unknown): Promise<ResourceUploadSession> {
    await this.authorize(scope);
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
      throw new Error("Resource upload chunks must use bounded canonical base64");
    const bytes = Buffer.from(input.dataBase64, "base64");
    if (
      !bytes.length ||
      bytes.length > this.options.maxChunkBytes ||
      bytes.toString("base64") !== input.dataBase64
    )
      throw new Error("Invalid resource upload chunk size or encoding");
    const digest = createHash("sha256").update(bytes).digest("hex"),
      key = this.key(scope, id);
    return this.locked(key, async () => {
      const record = await this.record(scope, id);
      if (record.state !== "uploading") throw new Error("Resource upload no longer accepts chunks");
      if (
        record.lastChunk?.sequence === sequence &&
        record.lastChunk.offset === offset &&
        record.lastChunk.bytes === bytes.length &&
        record.lastChunk.sha256 === digest
      )
        return this.view(record);
      if (sequence !== record.nextSequence || offset !== record.receivedBytes)
        throw new Error(
          "Resource upload chunks must arrive in sequence at the acknowledged offset",
        );
      if (offset + bytes.length > (record.expectedBytes ?? this.options.maxFileBytes))
        throw new Error("Resource upload exceeds its file budget");
      const handle = await open(
        join(await this.directory(scope, id), "content.partial"),
        constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size < record.receivedBytes)
          throw new Error("Stored resource upload bytes are incomplete");
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
            if (!bytesRead) throw new Error("Stored resource upload stopped making progress");
            hash.hash.update(buffer.subarray(0, bytesRead));
            hash.bytes += bytesRead;
          }
        }
        if (hash.hash.copy().digest("hex") !== record.contentSha256) throw invalidMedia();
        let written = 0;
        while (written < bytes.length) {
          await this.authorize(scope);
          const result = await handle.write(
            bytes,
            written,
            bytes.length - written,
            offset + written,
          );
          if (!result.bytesWritten)
            throw new Error("Resource upload write stopped making progress");
          written += result.bytesWritten;
        }
        await handle.sync();
        await this.authorize(scope);
        const time = this.options.now();
        const next: StoredSession = {
          ...record,
          receivedBytes: offset + bytes.length,
          nextSequence: sequence + 1,
          updatedAt: time,
          expiresAt: time + this.options.ttlMs,
          lastChunk: { sequence, offset, bytes: bytes.length, sha256: digest },
          contentSha256: hash.hash.copy().update(bytes).digest("hex"),
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
  async finish(
    scope: MediaScope,
    raw: unknown,
    externalSignal?: AbortSignal,
  ): Promise<ResourceUploadResult> {
    externalSignal?.throwIfAborted();
    await this.authorize(scope);
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
        throw new Error("Resource upload is incomplete or no longer accepts finalization");
      const controller = new AbortController();
      this.finishes.set(key, controller);
      // cancel may be queued behind a write before finish acquires the lock.
      // Remember that intent even when there is not yet a running process.
      if (this.cancellations.has(key)) controller.abort();
      const signal = AbortSignal.any([
        controller.signal,
        ...(externalSignal ? [externalSignal] : []),
        AbortSignal.timeout(this.options.finishTimeoutMs),
      ]);
      const directory = await this.directory(scope, id),
        path = join(directory, "content.partial");
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        await this.save({ ...record, state: "finishing" });
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
          await this.authorize(scope);
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
        if (
          sha256 !== record.contentSha256 ||
          (record.expectedSha256 !== undefined && sha256 !== record.expectedSha256)
        )
          throw invalidMedia();
        signal.throwIfAborted();
        await this.authorize(scope);
        const asset = await this.options.library.importFile(scope, path, {
          name: record.name,
          mimeType: record.mimeType,
          signal,
          expectedSource: identity,
          expectedBytes: record.receivedBytes,
          expectedSha256: sha256,
          assertAuthorized: () => this.authorize(scope),
        });
        if (asset.sha256 !== sha256 || asset.bytes !== record.receivedBytes) throw invalidMedia();
        signal.throwIfAborted();
        await this.authorize(scope);
        const result: ResourceUploadResult = { asset };
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
        const invalid = (error as Error).name === "InvalidResourceUploadError";
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
    await this.authorize(scope);
    await this.initialize();
    const id = sessionId(object(raw, ["sessionId"]).sessionId),
      key = this.key(scope, id);
    this.cancellations.add(key);
    this.finishes.get(key)?.abort();
    try {
      return await this.locked(key, async () => {
        const record = await this.record(scope, id);
        if (record.state === "finished")
          throw new Error("Resource upload is already a managed asset");
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

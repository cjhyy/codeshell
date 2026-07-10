import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { MobileImageBase, MobileImageMime } from "./types.js";

export const MAX_MOBILE_IMAGE_BYTES = 10 * 1024 * 1024;
export const MOBILE_UPLOAD_TTL_MS = 5 * 60 * 1000;
export const MAX_MOBILE_UPLOAD_TICKETS_PER_DEVICE = 16;
export const MAX_MOBILE_UPLOAD_CLAIM_ATTEMPTS = 3;

const IMAGE_MIMES = new Set<MobileImageMime>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

type UploadStatus = "pending" | "uploading" | "ready" | "claimed";

interface UploadRecord extends MobileImageBase {
  uploadId: string;
  deviceId: string;
  expiresAt: number;
  status: UploadStatus;
  path?: string;
  sha256?: string;
  claimId?: string;
  claimAttempts: number;
}

export interface MobileUploadServiceOptions {
  rootDir: string;
  now?: () => number;
  cleanupIntervalMs?: number;
  uploadTtlMs?: number;
}

export interface ClaimedMobileUpload extends MobileImageBase {
  uploadId: string;
  claimId: string;
  path: string;
  sha256: string;
}

function normalizedContentType(value: string | undefined): string {
  return String(value ?? "")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
}

function reply(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
}

interface ActiveTransfer {
  controller: AbortController;
  done: Promise<void>;
}

/** One-time, device-bound HTTP upload tickets backed by a temporary spool. */
export class MobileUploadService {
  private readonly uploads = new Map<string, UploadRecord>();
  private readonly activeTransfers = new Map<string, ActiveTransfer>();
  private readonly now: () => number;
  private readonly uploadTtlMs: number;
  private readonly startupCleanup: Promise<void>;
  private readonly timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private disposePromise?: Promise<void>;

  constructor(private readonly opts: MobileUploadServiceOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.uploadTtlMs = opts.uploadTtlMs ?? MOBILE_UPLOAD_TTL_MS;
    this.startupCleanup = this.cleanupOrphanSpools(this.now(), false);
    const interval = opts.cleanupIntervalMs ?? 60_000;
    if (interval > 0) {
      this.timer = setInterval(() => void this.cleanupExpired().catch(() => undefined), interval);
      this.timer.unref?.();
    }
  }

  /** Wait until startup orphan recovery has completed. */
  async ready(): Promise<void> {
    await this.startupCleanup;
  }

  begin(
    deviceId: string,
    metadata: Omit<MobileImageBase, "mime"> & { mime: string },
  ): {
    clientId: string;
    uploadId: string;
    putUrl: string;
    expiresAt: number;
  } {
    if (this.disposed) throw new Error("upload service is shutting down");
    void this.cleanupExpired().catch(() => undefined);
    const mime = normalizedContentType(metadata.mime) as MobileImageMime;
    if (!deviceId.trim()) throw new Error("authenticated device is required");
    if (!metadata.clientId?.trim()) throw new Error("attachment clientId is required");
    if (!metadata.name?.trim()) throw new Error("attachment name is required");
    if (!IMAGE_MIMES.has(mime)) throw new Error("unsupported image MIME");
    if (
      !Number.isSafeInteger(metadata.size) ||
      metadata.size <= 0 ||
      metadata.size > MAX_MOBILE_IMAGE_BYTES
    ) {
      throw new Error("attachment size is outside the allowed range");
    }
    let deviceTickets = 0;
    for (const upload of this.uploads.values()) {
      if (upload.deviceId === deviceId) deviceTickets += 1;
    }
    if (deviceTickets >= MAX_MOBILE_UPLOAD_TICKETS_PER_DEVICE) {
      throw new Error("too many pending attachment uploads for this device");
    }
    const uploadId = randomBytes(24).toString("base64url");
    const expiresAt = this.now() + this.uploadTtlMs;
    this.uploads.set(uploadId, {
      ...metadata,
      mime,
      uploadId,
      deviceId,
      expiresAt,
      status: "pending",
      claimAttempts: 0,
    });
    return {
      clientId: metadata.clientId,
      uploadId,
      putUrl: `/api/mobile/uploads/${uploadId}`,
      expiresAt,
    };
  }

  async acceptPut(uploadId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.ready();
    } catch {
      reply(res, 500, "upload storage is unavailable");
      return;
    }
    if (this.disposed) {
      reply(res, 503, "upload service is shutting down");
      return;
    }
    const record = this.uploads.get(uploadId);
    if (!record || record.expiresAt <= this.now()) {
      if (record) await this.expire(uploadId, record);
      reply(res, 404, "upload ticket not found or expired");
      return;
    }
    if (req.method !== "PUT") {
      reply(res, 405, "method not allowed");
      return;
    }
    if (record.status !== "pending") {
      reply(res, 409, "upload ticket is already in use");
      return;
    }
    if (normalizedContentType(req.headers["content-type"]) !== record.mime) {
      reply(res, 415, "content type does not match ticket");
      return;
    }
    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MOBILE_IMAGE_BYTES) {
      reply(res, 413, "upload is too large");
      return;
    }
    if (Number.isFinite(declaredLength) && declaredLength !== record.size) {
      reply(res, 400, "content length does not match ticket");
      return;
    }

    await mkdir(this.opts.rootDir, { recursive: true });
    const partPath = join(this.opts.rootDir, `${uploadId}.part`);
    const finalPath = join(this.opts.rootDir, `${uploadId}.upload`);
    const hash = createHash("sha256");
    let received = 0;
    let deadlineExpired = false;
    record.status = "uploading";
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.byteLength;
        if (received > MAX_MOBILE_IMAGE_BYTES) {
          callback(new Error("upload exceeds size limit"));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const controller = new AbortController();
    const deadline = setTimeout(
      () => {
        deadlineExpired = true;
        controller.abort(new Error("upload ticket expired during transfer"));
      },
      Math.max(0, record.expiresAt - this.now()),
    );
    deadline.unref?.();
    const transfer = pipeline(req, counter, createWriteStream(partPath, { flags: "wx" }), {
      signal: controller.signal,
    });
    this.activeTransfers.set(uploadId, { controller, done: transfer });
    try {
      await transfer;
      if (received !== record.size) {
        await rm(partPath, { force: true });
        record.status = "pending";
        reply(res, 400, "received size does not match ticket");
        return;
      }
      if (
        this.uploads.get(uploadId) !== record ||
        record.status !== "uploading" ||
        record.expiresAt <= this.now()
      ) {
        await rm(partPath, { force: true });
        if (this.uploads.get(uploadId) === record) this.uploads.delete(uploadId);
        reply(res, 408, "upload ticket expired during transfer");
        return;
      }
      await rename(partPath, finalPath);
      if (
        this.uploads.get(uploadId) !== record ||
        record.status !== "uploading" ||
        record.expiresAt <= this.now()
      ) {
        await rm(finalPath, { force: true });
        if (this.uploads.get(uploadId) === record) this.uploads.delete(uploadId);
        reply(res, 408, "upload ticket expired during transfer");
        return;
      }
      record.status = "ready";
      record.path = finalPath;
      record.sha256 = hash.digest("hex");
      reply(res, 201, "uploaded");
    } catch (error) {
      await rm(partPath, { force: true }).catch(() => undefined);
      const expired = deadlineExpired || record.expiresAt <= this.now();
      if (this.uploads.get(uploadId) === record) {
        if (expired || this.disposed) this.uploads.delete(uploadId);
        else record.status = "pending";
      }
      reply(
        res,
        expired ? 408 : String((error as Error).message).includes("size limit") ? 413 : 400,
        "upload failed",
      );
    } finally {
      clearTimeout(deadline);
      if (this.activeTransfers.get(uploadId)?.done === transfer) {
        this.activeTransfers.delete(uploadId);
      }
    }
  }

  /** Atomically move a ready upload into a request-owned lease. */
  claim(deviceId: string, uploadId: string): ClaimedMobileUpload {
    const record = this.uploads.get(uploadId);
    if (!record || record.expiresAt <= this.now()) {
      if (record) void this.expire(uploadId, record);
      throw new Error("upload is not ready or no longer exists");
    }
    if (record.deviceId !== deviceId) throw new Error("upload belongs to another device");
    if (record.status !== "ready") throw new Error("upload is already claimed or not ready");
    if (record.claimAttempts >= MAX_MOBILE_UPLOAD_CLAIM_ATTEMPTS) {
      void this.expire(uploadId, record);
      throw new Error("upload claim retry limit exceeded");
    }
    const claimId = randomBytes(18).toString("base64url");
    record.status = "claimed";
    record.claimId = claimId;
    record.claimAttempts += 1;
    return {
      uploadId,
      claimId,
      clientId: record.clientId,
      name: record.name,
      mime: record.mime,
      size: record.size,
      path: record.path!,
      sha256: record.sha256!,
    };
  }

  /** Release a failed staging/dispatch attempt for a bounded retry. */
  async release(deviceId: string, uploadId: string, claimId: string): Promise<void> {
    const record = this.assertClaimOwner(deviceId, uploadId, claimId);
    delete record.claimId;
    if (record.claimAttempts >= MAX_MOBILE_UPLOAD_CLAIM_ATTEMPTS) {
      this.uploads.delete(uploadId);
      if (record.path) await rm(record.path, { force: true }).catch(() => undefined);
      return;
    }
    record.status = "ready";
  }

  /** Finalize a successful turn; only the active claim owner may consume it. */
  async finalize(deviceId: string, uploadId: string, claimId: string): Promise<void> {
    const record = this.assertClaimOwner(deviceId, uploadId, claimId);
    this.uploads.delete(uploadId);
    if (record.path) await rm(record.path, { force: true }).catch(() => undefined);
  }

  async cleanupExpired(): Promise<void> {
    await this.ready();
    const now = this.now();
    const expired: Promise<void>[] = [];
    for (const [uploadId, record] of this.uploads) {
      if (record.expiresAt <= now) expired.push(this.expire(uploadId, record));
    }
    await Promise.allSettled(expired);
    await this.cleanupOrphanSpools(now, false);
  }

  /** Abort all in-flight transfers and invalidate every outstanding ticket. */
  async cancelActiveTransfers(): Promise<void> {
    await this.ready();
    const records = [...this.uploads.entries()];
    for (const [uploadId] of records) this.uploads.delete(uploadId);
    for (const transfer of this.activeTransfers.values()) {
      transfer.controller.abort(new Error("upload service stopped"));
    }
    await Promise.allSettled([...this.activeTransfers.values()].map((item) => item.done));
    await Promise.allSettled(
      records.map(([uploadId, record]) => this.cleanupRecordFiles(uploadId, record)),
    );
  }

  /** Fully await timer shutdown, active aborts, and every spool unlink. */
  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.disposePromise = (async () => {
      await this.cancelActiveTransfers();
      await this.cleanupOrphanSpools(this.now(), true);
    })();
    return this.disposePromise;
  }

  private async expire(uploadId: string, record: UploadRecord): Promise<void> {
    if (this.uploads.get(uploadId) === record) this.uploads.delete(uploadId);
    const active = this.activeTransfers.get(uploadId);
    if (active) {
      active.controller.abort(new Error("upload ticket expired"));
      await active.done.catch(() => undefined);
    }
    await this.cleanupRecordFiles(uploadId, record);
  }

  private async cleanupRecordFiles(uploadId: string, record?: UploadRecord): Promise<void> {
    await Promise.allSettled([
      rm(join(this.opts.rootDir, `${uploadId}.part`), { force: true }),
      rm(join(this.opts.rootDir, `${uploadId}.upload`), { force: true }),
      ...(record?.path ? [rm(record.path, { force: true })] : []),
    ]);
  }

  private async cleanupOrphanSpools(now: number, removeAll: boolean): Promise<void> {
    try {
      await mkdir(this.opts.rootDir, { recursive: true });
    } catch {
      return;
    }
    const entries = await readdir(this.opts.rootDir, { withFileTypes: true }).catch(() => []);
    const activeIds = new Set([...this.uploads.keys(), ...this.activeTransfers.keys()]);
    await Promise.allSettled(
      entries.map(async (entry) => {
        if (!entry.isFile()) return;
        const match = /^([A-Za-z0-9_-]+)\.(part|upload)$/.exec(entry.name);
        if (!match || activeIds.has(match[1]!)) return;
        const path = join(this.opts.rootDir, entry.name);
        if (!removeAll) {
          const info = await stat(path).catch(() => undefined);
          if (!info) return;
          if (info.mtimeMs + this.uploadTtlMs > now) return;
        }
        await rm(path, { force: true });
      }),
    );
  }

  private assertClaimOwner(deviceId: string, uploadId: string, claimId: string): UploadRecord {
    const record = this.uploads.get(uploadId);
    if (!record) throw new Error("upload claim no longer exists");
    if (record.deviceId !== deviceId) throw new Error("upload belongs to another device");
    if (record.status !== "claimed" || record.claimId !== claimId) {
      throw new Error("upload claim owner does not match");
    }
    return record;
  }
}

import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
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

/** One-time, device-bound HTTP upload tickets backed by a temporary spool. */
export class MobileUploadService {
  private readonly uploads = new Map<string, UploadRecord>();
  private readonly now: () => number;
  private readonly timer?: ReturnType<typeof setInterval>;

  constructor(private readonly opts: MobileUploadServiceOptions) {
    this.now = opts.now ?? (() => Date.now());
    const interval = opts.cleanupIntervalMs ?? 60_000;
    if (interval > 0) {
      this.timer = setInterval(() => this.cleanupExpired(), interval);
      this.timer.unref?.();
    }
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
    this.cleanupExpired();
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
    const expiresAt = this.now() + MOBILE_UPLOAD_TTL_MS;
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
    const record = this.uploads.get(uploadId);
    if (!record || record.expiresAt < this.now()) {
      if (record) this.expire(uploadId, record);
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
    try {
      await pipeline(req, counter, createWriteStream(partPath, { flags: "wx" }));
      if (received !== record.size) {
        await rm(partPath, { force: true });
        record.status = "pending";
        reply(res, 400, "received size does not match ticket");
        return;
      }
      await rename(partPath, finalPath);
      record.status = "ready";
      record.path = finalPath;
      record.sha256 = hash.digest("hex");
      reply(res, 201, "uploaded");
    } catch (error) {
      await rm(partPath, { force: true }).catch(() => undefined);
      if (this.uploads.get(uploadId) === record) record.status = "pending";
      reply(
        res,
        String((error as Error).message).includes("size limit") ? 413 : 400,
        "upload failed",
      );
    }
  }

  /** Atomically move a ready upload into a request-owned lease. */
  claim(deviceId: string, uploadId: string): ClaimedMobileUpload {
    const record = this.uploads.get(uploadId);
    if (!record || record.expiresAt < this.now()) {
      throw new Error("upload is not ready or no longer exists");
    }
    if (record.deviceId !== deviceId) throw new Error("upload belongs to another device");
    if (record.status !== "ready") throw new Error("upload is already claimed or not ready");
    if (record.claimAttempts >= MAX_MOBILE_UPLOAD_CLAIM_ATTEMPTS) {
      this.expire(uploadId, record);
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

  cleanupExpired(): void {
    const now = this.now();
    for (const [uploadId, record] of this.uploads) {
      if (record.expiresAt < now) this.expire(uploadId, record);
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    for (const [uploadId, record] of this.uploads) this.expire(uploadId, record);
  }

  private expire(uploadId: string, record: UploadRecord): void {
    this.uploads.delete(uploadId);
    if (record.path) void rm(record.path, { force: true }).catch(() => undefined);
    void rm(join(this.opts.rootDir, `${uploadId}.part`), { force: true }).catch(() => undefined);
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

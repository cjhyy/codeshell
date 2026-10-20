import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { lockSync } from "@cjhyy/code-shell-core/internal";
import {
  isStageableImageMime,
  markAttachmentsSent,
  MAX_STAGED_IMAGE_BYTES,
  stageFileBytes,
  stageImageBytes,
  type InputAttachmentMeta,
} from "../attachment-service.js";

const MAX_BYTES = 20 * 1024 * 1024;
const TTL_MS = 15 * 60 * 1000;
/** Instance leases are renewed every 10s; a lease idle for 30s belongs to a dead Host. */
const LEASE_STALE_MS = 30_000;
const LEASE_UPDATE_MS = 10_000;
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const LEGACY_SPOOL = new RegExp(`^${UUID}\\.upload$`);
const INSTANCE_ENTRY = new RegExp(`^(instance-${UUID})(?:\\.lock)?$`);

/** Image MIME types go through image staging; everything else is staged as a file. */
const routesToImageStaging = (mimeType: string): boolean =>
  mimeType.startsWith("image/") && mimeType !== "image/svg+xml";
const SAFE_ID = /^[a-zA-Z0-9_-]{8,80}$/;
// Match the session/history boundary so existing dotted session IDs can attach files.
const SAFE_SESSION_ID = /^(?!.*\.\.)[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;

export interface PreparedHubUploads {
  attachments: InputAttachmentMeta[];
  commit(): Promise<void>;
  release(): void;
}

const emptyUploads = (): PreparedHubUploads => ({
  attachments: [],
  commit: async () => {},
  release: () => {},
});

interface Upload {
  id: string;
  owner: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
  createdAt: number;
  status: "receiving" | "ready" | "claiming";
}

export function hubJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

/** Temporary, device-owned spools. Only the host can turn IDs into staged attachment paths. */
export class HubUploads {
  private readonly uploads = new Map<string, Upload>();
  private readonly active = new Set<IncomingMessage>();
  private closed = false;
  /** This Host's own spool directory, held by a renewed lease while it runs. */
  private readonly spool: string;
  private releaseLease?: () => void;

  constructor(
    private readonly root: string,
    private readonly cwd: string,
  ) {
    this.spool = join(root, `instance-${randomUUID()}`);
  }

  async ready(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe upload directory");
    await chmod(this.root, 0o700);
    // A pending draft cannot survive a restart; staged attachments live in the
    // workspace. Several Hosts (a duplicate launch that has not bound its port
    // yet, or another port) can share this root, so reclaim only spools that
    // are provably unused instead of everything present.
    await this.reclaimAbandoned();
    await mkdir(this.spool, { mode: 0o700 });
    this.releaseLease = lockSync(this.spool, {
      stale: LEASE_STALE_MS,
      update: LEASE_UPDATE_MS,
      realpath: false,
      retries: 0,
      // A lost lease only risks another Host reclaiming these drafts; sends then
      // fail with "upload not found", which the client already handles.
      onCompromised: () => {},
    });
  }

  private async reclaimAbandoned(): Promise<void> {
    const instances = new Set<string>();
    for (const name of await readdir(this.root)) {
      const instance = INSTANCE_ENTRY.exec(name)?.[1];
      if (instance) {
        instances.add(instance);
        continue;
      }
      // Hosts before instance leases spooled into the root. An older live Host
      // rejects anything past the TTL, so only expired files are safe to remove.
      if (!LEGACY_SPOOL.test(name)) continue;
      const path = join(this.root, name);
      const entry = await lstat(path).catch(() => undefined);
      if (entry?.isFile() && Date.now() - entry.mtimeMs >= TTL_MS) await rm(path, { force: true });
    }
    for (const instance of instances) {
      const path = join(this.root, instance);
      let release: () => void;
      try {
        // Succeeds only when no live Host renews this instance's lease.
        release = lockSync(path, { stale: LEASE_STALE_MS, realpath: false, retries: 0 });
      } catch {
        continue;
      }
      try {
        await rm(path, { recursive: true, force: true });
      } finally {
        release();
      }
    }
  }

  async accept(
    id: string,
    owner: string,
    req: IncomingMessage,
    res: ServerResponse,
    stillAuthorized: () => Promise<boolean>,
  ): Promise<void> {
    const reject = (status: number, error: string): void => {
      hubJson(res, status, { error });
      req.resume();
    };
    if (!SAFE_ID.test(id)) return reject(400, "invalid upload id");
    if (this.closed) return reject(503, "server is shutting down");
    await this.sweep();
    if (this.uploads.has(id)) return reject(409, "upload id already exists");
    if (
      this.active.size >= 4 ||
      this.uploads.size >= 32 ||
      [...this.uploads.values()].filter((entry) => entry.owner === owner).length >= 16
    ) {
      return reject(429, "too many uploads; send the current attachments first");
    }
    const size = Number(req.headers["content-length"]);
    if (!req.headers["content-length"]) return reject(411, "content length required");
    if (!Number.isSafeInteger(size) || size <= 0) return reject(400, "empty or invalid upload");
    if (size > MAX_BYTES) return reject(413, "attachment exceeds 20 MiB");
    const mimeType = String(req.headers["content-type"] ?? "application/octet-stream")
      .split(";", 1)[0]!
      .trim()
      .toLowerCase();
    if (mimeType.length > 128 || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mimeType)) {
      return reject(400, "invalid content type");
    }
    // Admit only what the send path can stage, so a draft never looks
    // uploaded and then fails on every Send.
    if (routesToImageStaging(mimeType)) {
      if (!isStageableImageMime(mimeType)) return reject(415, "unsupported image type");
      if (size > MAX_STAGED_IMAGE_BYTES) return reject(413, "image exceeds 10 MiB");
    }
    if (
      [...this.uploads.values()].reduce((sum, entry) => sum + entry.size, size) >
      128 * 1024 * 1024
    ) {
      return reject(429, "upload storage quota exceeded");
    }
    let name: string;
    try {
      name = decodeURIComponent(String(req.headers["x-file-name"] ?? "attachment"));
    } catch {
      return reject(400, "invalid file name");
    }
    if (!name.trim() || name.length > 255 || /[\x00-\x1f/\\]/.test(name)) {
      return reject(400, "invalid file name");
    }
    const upload: Upload = {
      id,
      owner,
      name,
      mimeType,
      size,
      path: join(this.spool, `${randomUUID()}.upload`),
      createdAt: Date.now(),
      status: "receiving",
    };
    this.uploads.set(id, upload);
    this.active.add(req);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    const deadline = setTimeout(() => req.destroy(new Error("upload timed out")), 30_000);
    deadline.unref?.();
    try {
      // Recheck the managed root: a workspace tool must not redirect the upload writer via symlink.
      for (const directory of [this.root, this.spool]) {
        const current = await lstat(directory);
        if (!current.isDirectory() || current.isSymbolicLink()) {
          throw new Error("unsafe upload directory");
        }
      }
      handle = await open(
        upload.path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      let received = 0;
      for await (const chunk of req) {
        received += chunk.length;
        if (received > size || received > MAX_BYTES)
          throw new Error("upload exceeds declared length");
        await handle.writeFile(chunk);
      }
      if (received !== size) throw new Error("incomplete upload");
      if (this.closed || !(await stillAuthorized())) {
        hubJson(res, 401, { error: "session expired" });
        throw new Error("session expired");
      }
      await handle.close();
      handle = undefined;
      upload.status = "ready";
      hubJson(res, 201, { id, name, mimeType, size, path: id });
    } catch (error) {
      this.uploads.delete(id);
      await handle?.close().catch(() => {});
      await rm(upload.path, { force: true });
      hubJson(res, 400, { error: error instanceof Error ? error.message : "upload failed" });
    } finally {
      clearTimeout(deadline);
      this.active.delete(req);
    }
  }

  async prepare(ids: unknown, owner: string, sessionId: unknown): Promise<PreparedHubUploads> {
    if (ids === undefined) return emptyUploads();
    if (
      !Array.isArray(ids) ||
      ids.length > 16 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== "string" || !SAFE_ID.test(id))
    ) {
      throw new Error("invalid upload ids");
    }
    if (!ids.length) return emptyUploads();
    if (typeof sessionId !== "string" || !SAFE_SESSION_ID.test(sessionId)) {
      throw new Error("valid sessionId required for attachments");
    }
    const records = ids.map((id) => {
      const record = this.uploads.get(id);
      if (
        !record ||
        record.owner !== owner ||
        record.status !== "ready" ||
        Date.now() - record.createdAt >= TTL_MS
      )
        throw new Error("upload not found or expired");
      return record;
    });
    for (const record of records) record.status = "claiming";
    try {
      const result: InputAttachmentMeta[] = [];
      for (const record of records) {
        const handle = await open(record.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        let bytes: Buffer;
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size !== record.size || info.size > MAX_BYTES)
            throw new Error("upload changed");
          bytes = await handle.readFile();
        } finally {
          await handle.close();
        }
        const input = {
          cwd: this.cwd,
          sessionId,
          name: record.name,
          mime: record.mimeType,
          bytes,
          origin: "mobile" as const,
        };
        result.push(
          routesToImageStaging(record.mimeType)
            ? await stageImageBytes(input)
            : await stageFileBytes(input),
        );
      }
      let settled = false;
      return {
        attachments: result,
        commit: async () => {
          if (settled) return;
          settled = true;
          for (const record of records) this.uploads.delete(record.id);
          try {
            await markAttachmentsSent(this.cwd, sessionId, result);
          } finally {
            for (const record of records) await rm(record.path, { force: true });
          }
        },
        release: () => {
          if (settled) return;
          settled = true;
          for (const record of records) record.status = "ready";
        },
      };
    } catch (error) {
      for (const record of records) record.status = "ready";
      throw error;
    }
  }

  /**
   * Drop an owner's unsent upload, for example when it is removed from the
   * draft. An upload being claimed by a send stays put. Returns whether the
   * upload was discarded.
   */
  async discard(id: string, owner: string): Promise<boolean> {
    const record = this.uploads.get(id);
    if (!record || record.owner !== owner || record.status !== "ready") return false;
    this.uploads.delete(id);
    await rm(record.path, { force: true });
    return true;
  }

  async sweep(): Promise<void> {
    for (const [id, record] of this.uploads) {
      if (record.status === "ready" && Date.now() - record.createdAt >= TTL_MS) {
        this.uploads.delete(id);
        await rm(record.path, { force: true });
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const req of this.active) req.destroy();
    for (const record of this.uploads.values()) await rm(record.path, { force: true });
    this.uploads.clear();
    if (this.releaseLease) {
      await rm(this.spool, { recursive: true, force: true });
      try {
        this.releaseLease();
      } catch {
        /* A compromised lease has nothing left to release. */
      }
      this.releaseLease = undefined;
    }
  }
}
